import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { FeeRateVersion } from '../entities/fee-rate-version.entity';
import { GradeCode } from '../common/enums';
import {
  addDays,
  diffDays,
  inclusiveDays,
  isValidDate,
} from '../common/date.util';
import { dailyTimesRate, moneyText } from '../common/money.util';

export interface FeeSegment {
  startDate: string;
  endDate: string;
  days: number;
  grade: GradeCode | null;
  dailyRate: string | null;
  amount: string;
  source:
    | 'GRADE_PERIOD_AND_RATE'
    | 'GRADE_PERIOD_NO_RATE'
    | 'NO_EFFECTIVE_GRADE';
  gradePeriodId: string | null;
  rateEffectiveFrom: string | null;
  note: string;
}

/**
 * 逐日定价行：账期/查询区间内每天一行，是月度账单快照明细与费用分段的**唯一同源内核**。
 * 账单封账冻结的就是这些行（含等级期间/日费版本来源 id）。
 */
export interface DailyPricingLine {
  date: string;
  grade: GradeCode | null;
  dailyRate: string | null;
  amount: string;
  source: FeeSegment['source'];
  gradePeriodId: string | null;
  rateVersionId: string | null;
  rateEffectiveFrom: string | null;
  note: string;
}

export interface PricingResult {
  elderId: string;
  from: string;
  to: string;
  totalDays: number;
  totalAmount: string;
  /** 按“连续同等级×同费率版本”合并的分段（与历史 /fees/segments 响应同构） */
  segments: FeeSegment[];
  /** 逐天明细（账单快照使用） */
  lines: DailyPricingLine[];
}

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

    const assessmentCase = await this.caseRepo.findOne({ where: { id: caseId } });
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
   * 逐日定价内核（闭区间 [from,to]，含首尾）：
   *  1) 取该老人与查询区间相交的等级期间，切成“天 × 等级”覆盖；
   *  2) 每段等级再按日费版本切换日拆分；
   *  3) 展开为逐天行并同时给出合并分段；decimal.js 计算，无等级天空洞金额 0；
   *  4) 天数守恒校验（行数/分段天数之和必须等于区间总天数）。
   * 月度账单的试算/封账/重开重算与 /fees/segments 共用本方法，保证口径一致。
   */
  async computePricing(
    elderId: string,
    from: string,
    to: string,
    manager?: EntityManager,
  ): Promise<PricingResult> {
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      throw new ConflictException({
        code: 'INVALID_RANGE',
        message: '查询区间日期不合法或起止倒置',
      });
    }

    const em = manager ?? this.dataSource.manager;
    const periods = await em.find(GradeEffectivePeriod, {
      where: { elderId },
      order: { startDate: 'ASC' },
    });
    const rateVersions = await em.find(FeeRateVersion, {
      order: { effectiveFrom: 'ASC' },
    });

    // 1) 等级覆盖轴：闭区间片段 [{start,end,grade,periodId}]，grade/periodId 允许为空（空洞）
    type CoverPiece = {
      start: string;
      end: string;
      grade: GradeCode | null;
      periodId: string | null;
    };
    const cover: CoverPiece[] = [];
    for (const p of periods) {
      const pEndInclusive = p.endDateExclusive
        ? addDays(p.endDateExclusive, -1)
        : to; // 开放区间在查询范围内取 to
      const s = p.startDate > from ? p.startDate : from;
      const e = pEndInclusive < to ? pEndInclusive : to;
      if (s <= e) {
        cover.push({ start: s, end: e, grade: p.grade, periodId: p.id });
      }
    }
    cover.sort((a, b) => (a.start < b.start ? -1 : 1));

    // 2) 填充无生效等级的空洞，保证逐天连续
    const merged: CoverPiece[] = [];
    let cursor = from;
    for (const c of cover) {
      if (c.start > cursor) {
        merged.push({ start: cursor, end: addDays(c.start, -1), grade: null, periodId: null });
      }
      merged.push(c);
      cursor = c.end < cursor ? cursor : addDays(c.end, 1);
    }
    if (cursor <= to) {
      merged.push({ start: cursor, end: to, grade: null, periodId: null });
    }

    // 3) 按日费版本切换日二次切分，得到富信息分段（带来源 id）
    interface RichPiece {
      startDate: string;
      endDate: string;
      days: number;
      grade: GradeCode | null;
      dailyRate: string | null;
      amount: string;
      source: FeeSegment['source'];
      gradePeriodId: string | null;
      rateVersionId: string | null;
      rateEffectiveFrom: string | null;
      note: string;
    }
    const rich: RichPiece[] = [];

    const pushLinesFor = (piece: RichPiece): void => {
      rich.push(piece);
    };

    for (const m of merged) {
      if (!m.grade) {
        const days = inclusiveDays(m.start, m.end);
        pushLinesFor({
          startDate: m.start,
          endDate: m.end,
          days,
          grade: null,
          dailyRate: null,
          amount: moneyText(0),
          source: 'NO_EFFECTIVE_GRADE',
          gradePeriodId: null,
          rateVersionId: null,
          rateEffectiveFrom: null,
          note: '无生效等级：不计费',
        });
        continue;
      }

      const versions = rateVersions
        .filter((r) => r.grade === m.grade && r.effectiveFrom <= m.end)
        .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));

      let segStart = m.start;
      for (let i = 0; i < versions.length; i++) {
        const v = versions[i];
        const nextV = versions[i + 1];
        const vStart = v.effectiveFrom < segStart ? segStart : v.effectiveFrom;
        if (vStart > m.end) break;
        const vEndInclusive = nextV
          ? minString(addDays(nextV.effectiveFrom, -1), m.end)
          : m.end;
        if (vStart > vEndInclusive) continue;

        const days = inclusiveDays(vStart, vEndInclusive);
        const amount = dailyTimesRate(v.dailyRate, days);
        pushLinesFor({
          startDate: vStart,
          endDate: vEndInclusive,
          days,
          grade: m.grade,
          dailyRate: moneyText(v.dailyRate),
          amount: moneyText(amount),
          source: 'GRADE_PERIOD_AND_RATE',
          gradePeriodId: m.periodId,
          rateVersionId: v.id,
          rateEffectiveFrom: v.effectiveFrom,
          note: `${m.grade} 等级期间 × 日费版本自 ${v.effectiveFrom} 起（${v.note ?? ''}）`,
        });
        segStart = addDays(vEndInclusive, 1);
      }

      // 等级存在但机构未定义任何日费规则
      if (!versions.length) {
        pushLinesFor({
          startDate: m.start,
          endDate: m.end,
          days: inclusiveDays(m.start, m.end),
          grade: m.grade,
          dailyRate: null,
          amount: moneyText(0),
          source: 'GRADE_PERIOD_NO_RATE',
          gradePeriodId: m.periodId,
          rateVersionId: null,
          rateEffectiveFrom: null,
          note: `等级 ${m.grade} 已生效但机构示例规则未定义日费：暂不计费`,
        });
      }
    }

    // 4) 展开逐天行（账单冻结明细）；金额以分段 decimal 为准
    const lines: DailyPricingLine[] = [];
    let total = new Decimal(0);
    let totalDays = 0;
    for (const p of rich) {
      total = total.plus(p.amount);
      totalDays += p.days;
      let d = p.startDate;
      while (d <= p.endDate) {
        lines.push({
          date: d,
          grade: p.grade,
          dailyRate: p.dailyRate,
          amount: p.dailyRate ? p.dailyRate : moneyText(0),
          source: p.source,
          gradePeriodId: p.gradePeriodId,
          rateVersionId: p.rateVersionId,
          rateEffectiveFrom: p.rateEffectiveFrom,
          note: p.note,
        });
        d = addDays(d, 1);
      }
    }

    // 天数守恒双校验：分段天数之和 + 逐天行数都必须等于区间总天数
    const expectedDays = diffDays(to, from) + 1;
    const segDays = rich.reduce((s, x) => s + x.days, 0);
    if (segDays !== expectedDays || lines.length !== expectedDays) {
      throw new Error(
        `费用分段天数不一致：分段 ${segDays} 天/逐天 ${lines.length} 行，区间 ${expectedDays} 天`,
      );
    }

    const segments: FeeSegment[] = rich.map((p) => ({
      startDate: p.startDate,
      endDate: p.endDate,
      days: p.days,
      grade: p.grade,
      dailyRate: p.dailyRate,
      amount: p.amount,
      source: p.source,
      gradePeriodId: p.gradePeriodId,
      rateEffectiveFrom: p.rateEffectiveFrom,
      note: p.note,
    }));

    return {
      elderId,
      from,
      to,
      totalDays,
      totalAmount: moneyText(total),
      segments,
      lines,
    };
  }

  /**
   * 按天分段费用（闭区间 [from,to]，含首尾）：
   * 响应结构保持历史兼容（等级、日费版本、天数、金额、来源逐段可解释）。
   */
  async feeSegments(
    elderId: string,
    from: string,
    to: string,
  ): Promise<{ elderId: string; from: string; to: string; totalDays: number; totalAmount: string; segments: FeeSegment[] }> {
    const pricing = await this.computePricing(elderId, from, to);
    return {
      elderId: pricing.elderId,
      from: pricing.from,
      to: pricing.to,
      totalDays: pricing.totalDays,
      totalAmount: pricing.totalAmount,
      segments: pricing.segments,
    };
  }
}

function minString(a: string, b: string): string {
  return a < b ? a : b;
}
