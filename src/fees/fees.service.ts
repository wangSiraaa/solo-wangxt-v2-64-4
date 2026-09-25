import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { FeeRateVersion } from '../entities/fee-rate-version.entity';
import { diffDays, isValidDate } from '../common/date.util';
import { computeDaily, Segment } from '../common/fee-calc.util';

export type FeeSegment = Segment;

@Injectable()
export class FeesService {
  constructor(
    @InjectRepository(AssessmentCase)
    private readonly caseRepo: Repository<AssessmentCase>,
    @InjectRepository(GradeEffectivePeriod)
    private readonly periodRepo: Repository<GradeEffectivePeriod>,
    @InjectRepository(FeeRateVersion)
    private readonly rateRepo: Repository<FeeRateVersion>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 等级生效（机构示例规则，独立于告知是否送达）。
   * 同一老人同一天不能出现重叠生效等级：
   *  - 生效日落入当前开放区间且等级不同（如月中升级）：旧区间截至前一日，新区间自当日起
   *  - 同一天已有相同等级生效：视为重复请求，回放已有区间
   *  - 任何其他重叠（同日不同等级、回溯日期撞未来区间）：409
   * 数据库 gist 排他约束为最终防线。
   */
  async activateGrade(
    caseId: string,
    effectiveDate: string,
    idempotencyKey?: string,
  ) {
    if (!isValidDate(effectiveDate)) {
      throw new ConflictException({
        code: 'INVALID_DATE',
        message: `生效日期 ${effectiveDate} 不是合法公历日期`,
      });
    }

    const assessmentCase = await this.caseRepo.findOne({
      where: { id: caseId },
    });
    if (!assessmentCase) throw new NotFoundException('评估案件不存在');
    if (!assessmentCase.confirmedGrade) {
      throw new ConflictException({
        code: 'GRADE_NOT_CONFIRMED',
        message: '等级尚未确认，不得生效费用',
      });
    }
    const grade = assessmentCase.confirmedGrade;

    return this.dataSource.transaction(async (em) => {
      // 行锁锁定该老人全部期间，避免并发生效造成同日重叠
      // 注意：原生查询的 date 列会返回 JS Date，统一转文本再比较
      const periods = await em.query(
        `SELECT id, grade,
                start_date::text AS start_date,
                end_date_exclusive::text AS end_date_exclusive,
                source_case_id
           FROM grade_periods WHERE elder_id = $1
           ORDER BY start_date FOR UPDATE`,
        [assessmentCase.elderId],
      );

      // 幂等：同案件 + 同生效日 + 同等级已存在
      const duplicate = periods.find(
        (p: any) =>
          p.source_case_id === caseId &&
          p.start_date === effectiveDate &&
          p.grade === grade,
      );
      if (duplicate) {
        return {
          replayed: true,
          message: '重复生效请求：同一天相同等级已生效，未重复生成',
          period: await em.findOne(GradeEffectivePeriod, {
            where: { id: duplicate.id },
          }),
        };
      }

      // 半开区间重叠：new=[d, ∞)
      for (const p of periods as any[]) {
        const pEnd = p.end_date_exclusive ?? '9999-12-31';
        const overlaps = effectiveDate < pEnd; // new 结束为 ∞，故只需判断 d < p.end
        if (!overlaps) continue;

        if (p.start_date === effectiveDate) {
          // 同一天已有生效等级
          if (p.grade === grade) {
            return {
              replayed: true,
              message: '同一天相同等级已存在，按重复请求回放',
              period: await em.findOne(GradeEffectivePeriod, {
                where: { id: p.id },
              }),
            };
          }
          throw new ConflictException({
            code: 'GRADE_PERIOD_OVERLAP_SAME_DAY',
            message: `生效日 ${effectiveDate} 已存在等级 ${p.grade}，同日不得重叠生效 ${grade}`,
            existingPeriodId: p.id,
          });
        }

        if (p.start_date < effectiveDate) {
          // 生效日落入已有区间内部（仅可能是开放区间或尚未结束的区间）
          if (p.grade === grade) {
            throw new ConflictException({
              code: 'GRADE_ALREADY_EFFECTIVE',
              message: `等级 ${grade} 已自 ${p.start_date} 起生效，同等级无需重复生效（日费调价由费用规则分段处理）`,
              existingPeriodId: p.id,
            });
          }
          // 月中升级/换级：旧区间截至生效日前一日
          await em.query(
            `UPDATE grade_periods SET end_date_exclusive = $1 WHERE id = $2`,
            [effectiveDate, p.id],
          );
        } else {
          // 回溯日期撞到未来区间
          throw new ConflictException({
            code: 'BACKDATED_OVERLAP',
            message: `生效日 ${effectiveDate} 早于已有未来生效区间（${p.start_date} 起 ${p.grade}），不得回溯重叠`,
            existingPeriodId: p.id,
          });
        }
      }

      try {
        const created = await em.save(GradeEffectivePeriod, {
          elderId: assessmentCase.elderId,
          grade,
          startDate: effectiveDate,
          endDateExclusive: null,
          sourceCaseId: caseId,
        });
        return { replayed: false, period: created };
      } catch (e: any) {
        if (e?.constraint === 'grade_periods_no_overlap') {
          throw new ConflictException({
            code: 'GRADE_PERIOD_OVERLAP_SAME_DAY',
            message: '同一天存在重叠生效等级（数据库排他约束拦截）',
          });
        }
        throw e;
      }
    });
  }

  /**
   * 按天分段费用（闭区间 [from,to]，含首尾）：
   *  1) 取该老人与查询区间相交的等级期间，逐天确定当天等级；
   *  2) 每天按 effectiveFrom 选当日生效日费版本；
   *  3) 逐日折叠成解释分段，decimal.js 计算合计；无生效等级的天空洞单列、金额 0。
   * 与月度账单共用 computeDaily 同一计费口径（含快照回放）。
   */
  async feeSegments(
    elderId: string,
    from: string,
    to: string,
  ): Promise<{
    elderId: string;
    from: string;
    to: string;
    totalDays: number;
    totalAmount: string;
    segments: FeeSegment[];
  }> {
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      throw new ConflictException({
        code: 'INVALID_RANGE',
        message: '查询区间日期不合法或起止倒置',
      });
    }

    const periods = await this.periodRepo.find({
      where: { elderId },
      order: { startDate: 'ASC' },
    });
    const rateVersions = await this.rateRepo.find({
      order: { effectiveFrom: 'ASC' },
    });

    const calc = computeDaily(
      periods.map((p) => ({
        id: p.id,
        grade: p.grade,
        startDate: p.startDate,
        endDateExclusive: p.endDateExclusive,
      })),
      rateVersions.map((r) => ({
        id: r.id,
        grade: r.grade,
        effectiveFrom: r.effectiveFrom,
        dailyRate: r.dailyRate,
        note: r.note,
      })),
      from,
      to,
    );

    // 天数守恒（computeDaily 已逐日守恒；此处保留对外一致的错误口径）
    if (calc.totalDays !== diffDays(to, from) + 1) {
      throw new Error(
        `费用分段天数不一致：分段 ${calc.totalDays} 天，区间 ${diffDays(to, from) + 1} 天`,
      );
    }

    return {
      elderId,
      from,
      to,
      totalDays: calc.totalDays,
      totalAmount: calc.totalAmount,
      segments: calc.segments,
    };
  }
}
