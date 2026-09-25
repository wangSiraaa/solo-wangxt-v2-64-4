import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import {
  AdjustmentStatus,
  AdjustmentType,
  BillEventType,
  BillStatus,
} from '../common/enums';
import { addDays, daysInMonth, isValidDate } from '../common/date.util';
import { moneyText } from '../common/money.util';
import { MonthlyBill, BillSnapshot } from '../entities/monthly-bill.entity';
import { BillDailyLine } from '../entities/bill-daily-line.entity';
import { BillAdjustmentSuggestion } from '../entities/bill-adjustment-suggestion.entity';
import { MonthlyBillEvent } from '../entities/monthly-bill-event.entity';
import {
  DailyPricingLine,
  FeesService,
  FeeSegment,
} from '../fees/fees.service';
import {
  BillListQueryDto,
  CloseBillDto,
  ReopenBillDto,
  TrialBillDto,
} from './dto/billing.dto';

/** 账单明细对外视图：账单 + 逐日冻结明细 + 合并分段 + 版本链 + 事件 + 调整建议 */
export interface BillDetail {
  id: string;
  elderId: string;
  billMonth: string;
  periodStart: string;
  periodEnd: string;
  versionNo: number;
  status: BillStatus;
  totalAmount: string;
  totalDays: number;
  reopenReason: string | null;
  frozen: boolean;
  snapshot: BillSnapshot | null;
  derivedFromBillId: string | null;
  supersededByBillId: string | null;
  createdAt: string;
  updatedAt: string;
  lines: BillDailyLine[];
  segments: FeeSegment[];
  suggestions: BillAdjustmentSuggestion[];
  events: MonthlyBillEvent[];
}

@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(MonthlyBill)
    private readonly billRepo: Repository<MonthlyBill>,
    private readonly feesService: FeesService,
    private readonly dataSource: DataSource,
  ) {}

  /** YYYY-MM → 账期首日/末日（按真实日历，闰月自动 29 天） */
  private monthRange(billMonth: string): { start: string; end: string } {
    const [y, m] = billMonth.split('-').map(Number);
    if (!isValidDate(`${billMonth}-01`)) {
      throw new ConflictException({
        code: 'INVALID_BILL_MONTH',
        message: `账单月份 ${billMonth} 不合法`,
      });
    }
    return {
      start: `${billMonth}-01`,
      end: `${billMonth}-${String(daysInMonth(y, m)).padStart(2, '0')}`,
    };
  }

  /** 以老人×月份为粒度的事务级咨询锁：串行化同月试算/封账/重开/差异写 */
  private async lockMonth(
    em: EntityManager,
    elderId: string,
    billMonth: string,
  ): Promise<void> {
    await em.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`monthly-bill|${elderId}|${billMonth}`],
    );
  }

  private async addEvent(
    em: EntityManager,
    bill: MonthlyBill,
    eventType: BillEventType,
    actor: string,
    reason: string | null,
    payload: unknown,
  ): Promise<MonthlyBillEvent> {
    const event = new MonthlyBillEvent();
    event.bill = bill;
    event.eventType = eventType;
    event.actor = actor;
    event.reason = reason;
    event.payload = payload ?? null;
    return em.save(event);
  }

  /** 删除旧逐日行并按当前定价写入新行（同事务，失败整体回滚不留半套明细） */
  private async replaceLines(
    em: EntityManager,
    bill: MonthlyBill,
    lines: DailyPricingLine[],
  ): Promise<void> {
    await em.query(`DELETE FROM bill_daily_lines WHERE bill_id = $1`, [bill.id]);
    if (!lines.length) {
      throw new UnprocessableEntityException({
        code: 'BILL_EMPTY_LINES',
        message: '重算未产出任何逐日明细，拒绝封账（天数守恒防线）',
      });
    }
    const values: string[] = [];
    const params: unknown[] = [bill.id];
    lines.forEach((l, i) => {
      const b = i * 9;
      values.push(
        `($1, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`,
      );
      params.push(
        l.date,
        l.grade,
        l.dailyRate,
        l.amount,
        l.source,
        l.note,
        l.gradePeriodId,
        l.rateVersionId,
        l.rateEffectiveFrom,
      );
    });
    await em.query(
      `INSERT INTO bill_daily_lines
         (bill_id, line_date, grade, daily_rate, amount, source, note,
          grade_period_id, rate_version_id, rate_effective_from)
       VALUES ${values.join(',')}`,
      params,
    );
  }

  /** 冻结快照：等级期间 + 日费版本 + 家属告知（封账时点定格） */
  private async buildSnapshot(
    em: EntityManager,
    elderId: string,
    start: string,
    end: string,
    lines: DailyPricingLine[],
  ): Promise<BillSnapshot> {
    const periodRows = await em.query(
      `SELECT id, grade,
              start_date::text AS start_date,
              end_date_exclusive::text AS end_date_exclusive,
              source_case_id::text AS source_case_id
         FROM grade_periods
        WHERE elder_id = $1
          AND start_date <= $3::date
          AND (end_date_exclusive IS NULL OR end_date_exclusive > $2::date)
        ORDER BY start_date`,
      [elderId, start, end],
    );
    const gradePeriods = periodRows.map((p: any) => ({
      id: p.id,
      grade: p.grade,
      startDate: p.start_date,
      endDateExclusive: p.end_date_exclusive,
      sourceCaseId: p.source_case_id,
    }));

    const rateIds = Array.from(
      new Set(lines.map((l) => l.rateVersionId).filter((x): x is string => !!x)),
    );
    const rateVersions: BillSnapshot['rateVersions'] = [];
    if (rateIds.length) {
      const rows = await em.query(
        `SELECT id, grade, effective_from::text AS effective_from,
                daily_rate::text AS daily_rate, note
           FROM fee_rate_versions WHERE id = ANY($1::uuid[])
          ORDER BY grade, effective_from`,
        [rateIds],
      );
      for (const r of rows) {
        rateVersions.push({
          id: r.id,
          grade: r.grade,
          effectiveFrom: r.effective_from,
          dailyRate: moneyText(r.daily_rate),
          note: r.note,
        });
      }
    }

    // 告知快照：该老人全部家属告知尝试（告知是案件状态留痕，不按账期月份裁剪，
    // 避免补封历史月份时漏冻结；封账时点定格全部送达状态/失败历史）
    const notifRows = await em.query(
      `SELECT n.id::text AS id, n.status, n.notifiable_status, n.attempts,
              to_char(n.last_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_attempt_at,
              n.failure_reason, n.message,
              to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM notification_records n
         JOIN assessment_cases c ON c.id = n.assessment_case_id
        WHERE c.elder_id = $1
        ORDER BY n.created_at`,
      [elderId],
    );
    const notifications = notifRows.map((n: any) => ({
      id: n.id,
      status: n.status,
      notifiableStatus: n.notifiable_status,
      attempts: n.attempts,
      lastAttemptAt: n.last_attempt_at,
      failureReason: n.failure_reason,
      message: n.message,
      createdAt: n.created_at,
    }));

    return {
      frozenAt: new Date().toISOString(),
      gradePeriods,
      rateVersions,
      notifications,
    };
  }

  /**
   * 试算：生成/刷新工作版本（DRAFT→TRIALED）。
   * 已封账月份不得直接新建草稿，必须走重开流程；重复试算幂等刷新同一工作版本。
   */
  async trial(dto: TrialBillDto): Promise<{ replayed: boolean; bill: BillDetail }> {
    const { start, end } = this.monthRange(dto.billMonth);
    const actor = dto.actor ?? 'SYSTEM';

    return this.dataSource.transaction(async (em) => {
      await this.lockMonth(em, dto.elderId, dto.billMonth);

      // 行锁锁定该月份全部版本（存在时）
      await em.query(
        `SELECT id FROM monthly_bills WHERE elder_id = $1 AND bill_month = $2 ORDER BY version_no FOR UPDATE`,
        [dto.elderId, dto.billMonth],
      );

      const working = await em.findOne(MonthlyBill, {
        where: [
          { elderId: dto.elderId, billMonth: dto.billMonth, status: BillStatus.TRIALED },
          { elderId: dto.elderId, billMonth: dto.billMonth, status: BillStatus.DRAFT },
        ],
      });

      let bill: MonthlyBill;
      let replayed = false;
      if (working) {
        bill = working;
        replayed = true;
      } else {
        // 已有有效封账：禁止绕过重开另起草稿
        const closed = await em.findOne(MonthlyBill, {
          where: {
            elderId: dto.elderId,
            billMonth: dto.billMonth,
            status: BillStatus.CLOSED,
          },
        });
        if (closed) {
          throw new ConflictException({
            code: 'BILL_ALREADY_CLOSED',
            message: `${dto.billMonth} 账单已封账（版本 ${closed.versionNo}），如需更正请先重开`,
            closedBillId: closed.id,
          });
        }

        const maxRow = await em.query(
          `SELECT COALESCE(MAX(version_no), 0) AS v FROM monthly_bills
            WHERE elder_id = $1 AND bill_month = $2`,
          [dto.elderId, dto.billMonth],
        );
        bill = em.create(MonthlyBill, {
          elderId: dto.elderId,
          billMonth: dto.billMonth,
          periodStart: start,
          periodEnd: end,
          versionNo: Number(maxRow[0].v) + 1,
          status: BillStatus.DRAFT,
          totalAmount: moneyText(0),
          totalDays: 0,
          snapshot: null,
        });
        bill = await em.save(bill);
      }

      const pricing = await this.feesService.computePricing(
        dto.elderId,
        start,
        end,
        em,
      );
      await this.replaceLines(em, bill, pricing.lines);
      bill.totalAmount = pricing.totalAmount;
      bill.totalDays = pricing.totalDays;
      bill.status = BillStatus.TRIALED;
      bill.snapshot = null;
      bill = await em.save(bill);
      await this.addEvent(
        em,
        bill,
        BillEventType.TRIALED,
        actor,
        null,
        {
          replayed,
          totalAmount: pricing.totalAmount,
          totalDays: pricing.totalDays,
          lineCount: pricing.lines.length,
        },
      );

      return { replayed, bill: await this.detail(em, bill.id) };
    });
  }

  /**
   * 封账：TRIALED → CLOSED。封账前按当前数据再算一次（避免试算陈旧），
   * 成功则冻结等级期间/日费版本/告知/逐日明细快照；任何失败整体回滚，账单退回 TRIALED。
   * 对已 CLOSED 账单重复封账：幂等回放，不产生新版本。
   * 若为重开派生版本：前置旧封账 REOPENED → SUPERSEDED，其未决调整建议标记已纳入。
   */
  async close(
    billId: string,
    dto: CloseBillDto,
  ): Promise<{ replayed: boolean; bill: BillDetail }> {
    const actor = dto.actor ?? 'SYSTEM';

    return this.dataSource.transaction(async (em) => {
      // 先找（不加锁）拿到老人×月份以获取咨询锁，再在锁内加行锁重读，保证全局锁序一致
      const found = await this.findOr404(em, billId);
      await this.lockMonth(em, found.elderId, found.billMonth);
      const bill = await this.lockRow(em, billId);
      if (bill.status === BillStatus.CLOSED) {
        return { replayed: true, bill: await this.detail(em, bill.id) };
      }
      if (bill.status !== BillStatus.TRIALED) {
        throw new ConflictException({
          code: 'BILL_NOT_TRIALED',
          message: `仅已试算账单可以封账，当前状态 ${bill.status}`,
        });
      }

      // 封账前以当前数据重算（事务内失败 → 整体回滚，不留半套明细）
      const pricing = await this.feesService.computePricing(
        bill.elderId,
        bill.periodStart,
        bill.periodEnd,
        em,
      );
      await this.replaceLines(em, bill, pricing.lines);
      const snapshot = await this.buildSnapshot(
        em,
        bill.elderId,
        bill.periodStart,
        bill.periodEnd,
        pricing.lines,
      );

      bill.totalAmount = pricing.totalAmount;
      bill.totalDays = pricing.totalDays;
      bill.snapshot = snapshot;
      bill.status = BillStatus.CLOSED;
      await em.save(bill);

      // 版本链闭合：旧封账（重开中）→ 已替代；其未决调整随新版本入账
      if (bill.derivedFromBillId) {
        const predecessor = await em.findOne(MonthlyBill, {
          where: { id: bill.derivedFromBillId },
        });
        if (predecessor) {
          predecessor.status = BillStatus.SUPERSEDED;
          predecessor.supersededByBillId = bill.id;
          await em.save(predecessor);
          await this.addEvent(
            em,
            predecessor,
            BillEventType.SUPERSEDED,
            actor,
            predecessor.reopenReason,
            { supersededByBillId: bill.id, newVersionNo: bill.versionNo },
          );

          const openSuggestions = await em.find(BillAdjustmentSuggestion, {
            where: { billId: predecessor.id, status: AdjustmentStatus.OPEN },
          });
          for (const s of openSuggestions) {
            s.status = AdjustmentStatus.INCORPORATED;
            s.resolvedByBillId = bill.id;
            await em.save(s);
          }
          if (openSuggestions.length) {
            await this.addEvent(
              em,
              predecessor,
              BillEventType.ADJUSTMENT_INCORPORATED,
              actor,
              null,
              {
                resolvedByBillId: bill.id,
                count: openSuggestions.length,
                suggestionIds: openSuggestions.map((s) => s.id),
              },
            );
          }
        }
      }

      await this.addEvent(em, bill, BillEventType.CLOSED, actor, dto.comment ?? null, {
        totalAmount: pricing.totalAmount,
        totalDays: pricing.totalDays,
        frozenGradePeriods: snapshot.gradePeriods.length,
        frozenRateVersions: snapshot.rateVersions.length,
        frozenNotifications: snapshot.notifications.length,
      });

      return { replayed: false, bill: await this.detail(em, bill.id) };
    });
  }

  /**
   * 重开：CLOSED → REOPENED，并从原封账快照派生新版本（TRIALED，version_no+1）。
   * 必须填写原因；重算使用当前数据（费率补录/评估更正后的口径）。
   * 并发重开由咨询锁 + “唯一工作版本”索引双保险：仅一个新版本，旧账仍可追溯。
   * 重算失败：事务回滚，不留下新版本/半套明细，旧封账保持 CLOSED 可用，并留失败事件。
   */
  async reopen(billId: string, dto: ReopenBillDto): Promise<{
    predecessor: { id: string; status: BillStatus; versionNo: number };
    successor: BillDetail;
  }> {
    const actor = dto.actor ?? 'SYSTEM';

    const run = async (em: EntityManager) => {
      const found = await this.findOr404(em, billId);
      await this.lockMonth(em, found.elderId, found.billMonth);
      const bill = await this.lockRow(em, billId);

      if (bill.status === BillStatus.REOPENED) {
        throw new ConflictException({
          code: 'BILL_ALREADY_REOPENED',
          message: `版本 ${bill.versionNo} 已重开，派生新版本工作中，不得重复重开`,
          successorBillId: bill.supersededByBillId,
        });
      }
      if (bill.status === BillStatus.SUPERSEDED) {
        throw new ConflictException({
          code: 'BILL_SUPERSEDED',
          message: `版本 ${bill.versionNo} 已被替代，不能重开；请重开当前有效封账`,
          activeBillId: bill.supersededByBillId,
        });
      }
      if (bill.status !== BillStatus.CLOSED) {
        throw new ConflictException({
          code: 'BILL_NOT_CLOSED',
          message: `仅已封账账单可以重开，当前状态 ${bill.status}`,
        });
      }
      if (!bill.snapshot) {
        // 约束理论上不可达，防御性处理
        throw new ConflictException({
          code: 'BILL_SNAPSHOT_MISSING',
          message: '原封账缺少冻结快照，无法派生新版本',
        });
      }

      // 从原快照派生新版本（版本链指针 + 冻结基线留痕）
      const successor = em.create(MonthlyBill, {
        elderId: bill.elderId,
        billMonth: bill.billMonth,
        periodStart: bill.periodStart,
        periodEnd: bill.periodEnd,
        versionNo: bill.versionNo + 1,
        status: BillStatus.DRAFT,
        totalAmount: bill.totalAmount,
        totalDays: bill.totalDays,
        snapshot: null,
        derivedFromBillId: bill.id,
      });
      const savedSuccessor = await em.save(successor);

      // 以当前数据重算（抛错则整个事务回滚：新版本与半套明细都不会落库）
      const pricing = await this.feesService.computePricing(
        bill.elderId,
        bill.periodStart,
        bill.periodEnd,
        em,
      );
      await this.replaceLines(em, savedSuccessor, pricing.lines);
      savedSuccessor.totalAmount = pricing.totalAmount;
      savedSuccessor.totalDays = pricing.totalDays;
      savedSuccessor.status = BillStatus.TRIALED;
      await em.save(savedSuccessor);

      bill.status = BillStatus.REOPENED;
      bill.reopenReason = dto.reason;
      bill.supersededByBillId = savedSuccessor.id;
      await em.save(bill);

      await this.addEvent(em, bill, BillEventType.REOPENED, actor, dto.reason, {
        successorBillId: savedSuccessor.id,
        newVersionNo: savedSuccessor.versionNo,
        frozenBaselineAmount: bill.totalAmount,
        recomputedAmount: pricing.totalAmount,
      });
      await this.addEvent(
        em,
        savedSuccessor,
        BillEventType.TRIALED,
        actor,
        null,
        {
          derivedFromBillId: bill.id,
          derivedFromVersionNo: bill.versionNo,
          reopenReason: dto.reason,
          totalAmount: pricing.totalAmount,
          totalDays: pricing.totalDays,
        },
      );

      const successorDetail = await this.detail(em, savedSuccessor.id);
      return {
        predecessor: {
          id: bill.id,
          status: BillStatus.REOPENED,
          versionNo: bill.versionNo,
        },
        successor: successorDetail,
      };
    };

    try {
      return await this.dataSource.transaction(run);
    } catch (e: any) {
      // 业务异常（404/409 等）原样抛出
      if (e?.status && typeof e.status === 'number') throw e;

      // 重算失败：独立事务留痕（原事务已回滚），旧封账保持可用
      try {
        await this.dataSource.transaction(async (em) => {
          const bill = await em.findOne(MonthlyBill, { where: { id: billId } });
          if (bill) {
            await this.addEvent(
              em,
              bill,
              BillEventType.RECOMPUTE_FAILED,
              actor,
              dto.reason,
              {
                error: String(e?.message ?? e),
                code: e?.code ?? null,
                at: new Date().toISOString(),
              },
            );
          }
        });
      } catch {
        /* 留痕失败不掩盖原始错误 */
      }
      throw new UnprocessableEntityException({
        code: 'BILL_RECOMPUTE_FAILED',
        message:
          '重开重算失败：已回滚，未产生新版本或半成品明细，原封账仍然有效可用',
        detail: String(e?.message ?? e),
        closedBillId: billId,
      });
    }
  }

  /**
   * 差异查询：对比冻结逐日明细与按当前数据的重算结果。
   * 已封账金额绝不改写；金额差异只生成（或刷新）OPEN 调整建议。
   * CLOSED/REOPENED 可写建议；SUPERSEDED 只读回放历史。
   */
  async diff(billId: string, actor = 'SYSTEM') {
    return this.dataSource.transaction(async (em) => {
      const found = await this.findOr404(em, billId);
      const readOnly = found.status === BillStatus.SUPERSEDED;
      // SUPERSEDED 只读回放，不加写锁；其余状态在咨询锁内行锁串行化
      if (!readOnly) {
        await this.lockMonth(em, found.elderId, found.billMonth);
      }
      const bill = readOnly ? found : await this.lockRow(em, billId);
      if (
        bill.status !== BillStatus.CLOSED &&
        bill.status !== BillStatus.REOPENED &&
        bill.status !== BillStatus.SUPERSEDED
      ) {
        throw new ConflictException({
          code: 'BILL_NOT_FROZEN',
          message: `账单尚未封账（${bill.status}），无冻结基线可比较`,
        });
      }

      const frozenLines = await em.find(BillDailyLine, {
        where: { billId: bill.id },
        order: { lineDate: 'ASC' },
      });
      const pricing = await this.feesService.computePricing(
        bill.elderId,
        bill.periodStart,
        bill.periodEnd,
        em,
      );
      const currentByDate = new Map(pricing.lines.map((l) => [l.date, l]));

      const existing = readOnly
        ? []
        : await em.find(BillAdjustmentSuggestion, {
            where: { billId: bill.id, status: AdjustmentStatus.OPEN },
          });
      const existingByDate = new Map(existing.map((s) => [s.lineDate, s]));
      const touched: BillAdjustmentSuggestion[] = [];
      let deltaTotal = new Decimal(0);

      for (const frozen of frozenLines) {
        const cur = currentByDate.get(frozen.lineDate);
        const currentAmount = cur ? new Decimal(cur.amount) : new Decimal(0);
        const frozenAmount = new Decimal(frozen.amount);
        const delta = currentAmount.minus(frozenAmount);

        const old = existingByDate.get(frozen.lineDate);
        if (delta.comparedTo(0) === 0) {
          // 数据恢复一致：撤销早先建议（不跨期挂账已消失的差异）
          if (old && !readOnly) {
            await em.remove(old);
          }
          continue;
        }
        deltaTotal = deltaTotal.plus(delta);

        if (readOnly) continue;

        const gradeChanged = frozen.grade !== (cur?.grade ?? null);
        const type = gradeChanged
          ? AdjustmentType.GRADE_CHANGED
          : AdjustmentType.RATE_CHANGED;
        const note = gradeChanged
          ? `等级期间更正：${frozen.lineDate} 等级 ${frozen.grade ?? '无'} → ${cur?.grade ?? '无'}（封账金额不变，仅生成跨期调整建议）`
          : `费率补录/变更：${frozen.lineDate} 日费 ${frozen.dailyRate ?? '未定义'} → ${cur?.dailyRate ?? '未定义'}（封账金额不变，仅生成跨期调整建议）`;

        if (old && old.adjustmentType === type) {
          old.frozenAmount = moneyText(frozenAmount);
          old.currentAmount = moneyText(currentAmount);
          old.deltaAmount = moneyText(delta);
          old.frozenGrade = frozen.grade;
          old.currentGrade = cur?.grade ?? null;
          old.frozenDailyRate = frozen.dailyRate;
          old.currentDailyRate = cur?.dailyRate ?? null;
          old.note = note;
          await em.save(old);
          touched.push(old);
        } else {
          if (old) await em.remove(old); // 同日类型迁移：删旧建议再按新类型挂账
          const suggestion = em.create(BillAdjustmentSuggestion, {
            bill,
            adjustmentType: type,
            lineDate: frozen.lineDate,
            frozenAmount: moneyText(frozenAmount),
            currentAmount: moneyText(currentAmount),
            deltaAmount: moneyText(delta),
            frozenGrade: frozen.grade,
            currentGrade: cur?.grade ?? null,
            frozenDailyRate: frozen.dailyRate,
            currentDailyRate: cur?.dailyRate ?? null,
            note,
            status: AdjustmentStatus.OPEN,
          });
          const saved = await em.save(suggestion);
          touched.push(saved);
        }
      }

      if (!readOnly && touched.length) {
        await this.addEvent(
          em,
          bill,
          BillEventType.ADJUSTMENT_PROPOSED,
          actor,
          null,
          {
            changedDays: touched.length,
            deltaAmount: moneyText(deltaTotal),
            suggestionIds: touched.map((s) => s.id),
          },
        );
      }

      // 告知变化：仅作信息呈现（封账快照 vs 当前），不改账
      const notificationChanges = this.diffNotifications(
        bill.snapshot,
        await this.currentNotifications(em, bill.elderId),
      );

      const allSuggestions = await em.find(BillAdjustmentSuggestion, {
        where: { billId: bill.id },
        order: { lineDate: 'ASC' },
      });
      const openSuggestions = allSuggestions.filter(
        (s) => s.status === AdjustmentStatus.OPEN,
      );
      const openDelta = openSuggestions.reduce(
        (sum, s) => sum.plus(s.deltaAmount),
        new Decimal(0),
      );

      return {
        billId: bill.id,
        billMonth: bill.billMonth,
        versionNo: bill.versionNo,
        status: bill.status,
        frozenAmount: bill.totalAmount,
        currentAmount: pricing.totalAmount,
        deltaAmount: moneyText(new Decimal(pricing.totalAmount).minus(bill.totalAmount)),
        openDeltaAmount: moneyText(openDelta),
        changedDays: touched.length,
        readOnly,
        message:
          touched.length > 0
            ? `检测到 ${touched.length} 天差异：已封账金额保持不变，仅生成跨期调整建议；重开并再次封账后建议纳入新版本`
            : '封账基线与当前数据一致，无未决调整建议',
        suggestions: allSuggestions,
        notificationChanges,
      };
    });
  }

  private async currentNotifications(
    em: EntityManager,
    elderId: string,
  ): Promise<BillSnapshot['notifications']> {
    const rows = await em.query(
      `SELECT n.id::text AS id, n.status, n.notifiable_status, n.attempts,
              to_char(n.last_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_attempt_at,
              n.failure_reason, n.message,
              to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM notification_records n
         JOIN assessment_cases c ON c.id = n.assessment_case_id
        WHERE c.elder_id = $1
        ORDER BY n.created_at`,
      [elderId],
    );
    return rows.map((n: any) => ({
      id: n.id,
      status: n.status,
      notifiableStatus: n.notifiable_status,
      attempts: n.attempts,
      lastAttemptAt: n.last_attempt_at,
      failureReason: n.failure_reason,
      message: n.message,
      createdAt: n.created_at,
    }));
  }

  private diffNotifications(
    snapshot: BillSnapshot | null,
    current: BillSnapshot['notifications'],
  ) {
    const frozen = snapshot?.notifications ?? [];
    const frozenById = new Map(frozen.map((n) => [n.id, n]));
    const currentById = new Map(current.map((n) => [n.id, n]));
    const added = current.filter((n) => !frozenById.has(n.id));
    const changed = current.filter((n) => {
      const f = frozenById.get(n.id);
      return (
        f &&
        (f.status !== n.status ||
          f.notifiableStatus !== n.notifiableStatus ||
          f.attempts !== n.attempts)
      );
    });
    return {
      frozenCount: frozen.length,
      currentCount: current.length,
      added: added.map((n) => ({
        id: n.id,
        status: n.status,
        notifiableStatus: n.notifiableStatus,
        attempts: n.attempts,
      })),
      changed: changed.map((n) => ({
        id: n.id,
        from: {
          status: frozenById.get(n.id)!.status,
          notifiableStatus: frozenById.get(n.id)!.notifiableStatus,
          attempts: frozenById.get(n.id)!.attempts,
        },
        to: {
          status: n.status,
          notifiableStatus: n.notifiableStatus,
          attempts: n.attempts,
        },
      })),
    };
  }

  async get(billId: string): Promise<BillDetail> {
    return this.dataSource.transaction(async (em) => this.detail(em, billId));
  }

  async list(q: BillListQueryDto): Promise<MonthlyBill[]> {
    return this.billRepo.find({
      where: q.billMonth
        ? { elderId: q.elderId, billMonth: q.billMonth }
        : { elderId: q.elderId },
      order: { billMonth: 'ASC', versionNo: 'ASC' },
    });
  }

  /** 取账单（不加锁）；不存在 → 404 */
  private async findOr404(
    em: EntityManager,
    billId: string,
  ): Promise<MonthlyBill> {
    const bill = await em.findOneBy(MonthlyBill, { id: billId });
    if (!bill) {
      throw new NotFoundException({
        code: 'BILL_NOT_FOUND',
        message: `月度账单 ${billId} 不存在`,
      });
    }
    return bill;
  }

  /** 在已持有咨询锁的前提下对账单行加 FOR UPDATE 并重读最新状态 */
  private async lockRow(
    em: EntityManager,
    billId: string,
  ): Promise<MonthlyBill> {
    const locked = await em.query(
      `SELECT id FROM monthly_bills WHERE id = $1 FOR UPDATE`,
      [billId],
    );
    if (!locked.length) {
      throw new NotFoundException({
        code: 'BILL_NOT_FOUND',
        message: `月度账单 ${billId} 不存在`,
      });
    }
    const bill = await em.findOneBy(MonthlyBill, { id: billId });
    return bill!;
  }

  /** 组装账单完整明细（逐日行、合并分段、事件、调整建议） */
  private async detail(em: EntityManager, billId: string): Promise<BillDetail> {
    const bill = await em.findOneBy(MonthlyBill, { id: billId });
    if (!bill) {
      throw new NotFoundException({
        code: 'BILL_NOT_FOUND',
        message: `月度账单 ${billId} 不存在`,
      });
    }
    const lines = await em.find(BillDailyLine, {
      where: { billId },
      order: { lineDate: 'ASC' },
    });
    const suggestions = await em.find(BillAdjustmentSuggestion, {
      where: { billId },
      order: { lineDate: 'ASC' },
    });
    const events = await em.find(MonthlyBillEvent, {
      where: { billId },
      order: { createdAt: 'ASC' },
    });

    return {
      id: bill.id,
      elderId: bill.elderId,
      billMonth: bill.billMonth,
      periodStart: bill.periodStart,
      periodEnd: bill.periodEnd,
      versionNo: bill.versionNo,
      status: bill.status,
      totalAmount: moneyText(bill.totalAmount),
      totalDays: bill.totalDays,
      reopenReason: bill.reopenReason,
      frozen: bill.snapshot !== null && bill.status !== BillStatus.TRIALED,
      snapshot: bill.snapshot,
      derivedFromBillId: bill.derivedFromBillId,
      supersededByBillId: bill.supersededByBillId,
      createdAt: (bill.createdAt as Date).toISOString(),
      updatedAt: (bill.updatedAt as Date).toISOString(),
      lines: lines.map((l) => ({
        ...l,
        dailyRate: l.dailyRate !== null ? moneyText(l.dailyRate) : null,
        amount: moneyText(l.amount),
      })),
      segments: mergeLinesToSegments(lines),
      suggestions: suggestions.map((s) => ({
        ...s,
        frozenAmount: moneyText(s.frozenAmount),
        currentAmount: moneyText(s.currentAmount),
        deltaAmount: moneyText(s.deltaAmount),
        frozenDailyRate:
          s.frozenDailyRate !== null ? moneyText(s.frozenDailyRate) : null,
        currentDailyRate:
          s.currentDailyRate !== null ? moneyText(s.currentDailyRate) : null,
      })),
      events,
    };
  }
}

/** 连续同等级×同日费版本×同来源的逐日行合并为可解释分段 */
function mergeLinesToSegments(lines: BillDailyLine[]): FeeSegment[] {
  const segments: FeeSegment[] = [];
  for (const l of lines) {
    const last = segments[segments.length - 1];
    const sameGroup =
      last &&
      last.grade === (l.grade as GradeLike) &&
      last.rateEffectiveFrom === (l.rateEffectiveFrom as string | null) &&
      last.source === l.source &&
      last.note === l.note &&
      addDays(last.endDate, 1) === l.lineDate;
    if (sameGroup) {
      last.endDate = l.lineDate;
      last.days += 1;
      last.amount = moneyText(new Decimal(last.amount).plus(l.amount));
    } else {
      segments.push({
        startDate: l.lineDate,
        endDate: l.lineDate,
        days: 1,
        grade: (l.grade as FeeSegment['grade']) ?? null,
        dailyRate: l.dailyRate !== null ? moneyText(l.dailyRate) : null,
        amount: moneyText(l.amount),
        source: l.source as FeeSegment['source'],
        gradePeriodId: l.gradePeriodId,
        rateEffectiveFrom: l.rateEffectiveFrom,
        note: l.note,
      });
    }
  }
  return segments;
}

type GradeLike = FeeSegment['grade'];
