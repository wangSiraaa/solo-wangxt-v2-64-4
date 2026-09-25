import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { v5 as uuidV5 } from 'uuid';
import Decimal from 'decimal.js';
import {
  BillAdjustmentChangeType,
  BillAdjustmentStatus,
  BillStatus,
} from '../common/enums';
import { daysInMonth, isValidDate } from '../common/date.util';
import { computeDaily } from '../common/fee-calc.util';
import { moneyText } from '../common/money.util';
import { MonthlyBill, BillSnapshot } from '../entities/monthly-bill.entity';
import { BillDailyLine } from '../entities/bill-daily-line.entity';
import { ReopenBillDto, SealBillDto, TrialBillDto } from './dto/bill.dto';
import { aggregateSuggestions, diffDaily } from './bill-diff.util';
import {
  buildSnapshot,
  fingerprintOf,
  loadLiveNotifications,
  loadLivePeriods,
  loadLiveRates,
  snapshotToCalc,
} from './bill-snapshot.util';

/** 仅用于试算阶段模拟重算失败：失败也不得写入半套明细 */
class RecomputeError extends Error {}

@Injectable()
export class BillsService {
  constructor(
    @InjectRepository(MonthlyBill)
    private readonly billRepo: Repository<MonthlyBill>,
    @InjectRepository(BillDailyLine)
    private readonly lineRepo: Repository<BillDailyLine>,
    private readonly dataSource: DataSource,
  ) {}

  // ---------------------------------------------------------------- 月份工具

  monthRange(billMonth: string): { from: string; to: string } {
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(billMonth);
    if (!m) {
      throw new ConflictException({
        code: 'INVALID_BILL_MONTH',
        message: `账单月份 ${billMonth} 不合法（应为 YYYY-MM）`,
      });
    }
    const year = Number(m[1]);
    const mon = Number(m[2]);
    const from = `${billMonth}-01`;
    const to = `${billMonth}-${String(daysInMonth(year, mon)).padStart(2, '0')}`;
    if (!isValidDate(from) || !isValidDate(to)) {
      throw new ConflictException({
        code: 'INVALID_BILL_MONTH',
        message: `账单月份 ${billMonth} 日期边界不合法`,
      });
    }
    return { from, to };
  }

  /**
   * 同一（老人，月份）的状态变更串行化：事务级 advisory lock。
   * 配合行锁 FOR UPDATE 与部分唯一索引，三重保证重复/并发操作不产生
   * 双有效账单。
   */
  private async lockMonth(
    em: EntityManager,
    elderId: string,
    billMonth: string,
  ) {
    await em.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      `monthly-bill:${billMonth}`,
      elderId,
    ]);
  }

  private async findVersionsLocked(
    em: EntityManager,
    elderId: string,
    billMonth: string,
  ): Promise<MonthlyBill[]> {
    return em.find(MonthlyBill, {
      where: { elderId, billMonth },
      order: { versionNo: 'ASC' },
    });
  }

  private async getBillForUpdate(
    em: EntityManager,
    id: string,
  ): Promise<MonthlyBill> {
    const rows = await em.query(
      `SELECT id FROM monthly_bills WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!rows.length) throw new NotFoundException('月度账单不存在');
    const bill = await em.findOneBy(MonthlyBill, { id });
    if (!bill) throw new NotFoundException('月度账单不存在');
    return bill;
  }

  // ---------------------------------------------------------------- 创建草稿

  /**
   * 创建（或幂等回放）月度账单草稿：
   *  - 已存在有效封账版本：拒绝（必须先重开），不另起草稿；
   *  - 已存在 DRAFT/TRIALED 开放版本：回放（重复请求不产生第二条）；
   *  - 否则按版本链取下一个版本号新建 DRAFT。
   */
  async createDraft(elderId: string, billMonth: string) {
    this.monthRange(billMonth);
    try {
      return await this.dataSource.transaction(async (em) => {
        await this.lockMonth(em, elderId, billMonth);
        const versions = await this.findVersionsLocked(em, elderId, billMonth);

        const sealed = versions.find((b) => b.status === BillStatus.SEALED);
        if (sealed) {
          throw new ConflictException({
            code: 'MONTH_ALREADY_SEALED',
            message: `老人 ${elderId} 的 ${billMonth} 账单已封账（版本 v${sealed.versionNo}），如需更正请先重开`,
            billId: sealed.id,
          });
        }

        const open = versions.find(
          (b) =>
            b.status === BillStatus.DRAFT || b.status === BillStatus.TRIALED,
        );
        if (open) {
          return { replayed: true, bill: this.serialize(open) };
        }

        const versionNo = versions.length
          ? Math.max(...versions.map((b) => b.versionNo)) + 1
          : 1;
        const bill = em.create(MonthlyBill, {
          elderId,
          billMonth,
          versionNo,
          status: BillStatus.DRAFT,
          totalAmount: '0.00',
          totalDays: 0,
          sourceFingerprint: '',
          sealedSnapshot: null,
          predecessorId: null,
        });
        await em.save(bill);
        return { replayed: false, bill: this.serialize(bill) };
      });
    } catch (e: any) {
      throw mapPersistenceError(e);
    }
  }

  // ---------------------------------------------------------------- 试算

  /**
   * 试算/重算：先在内存中按当前实时数据完成整月逐日计费，
   * 成功后事务内“整删整插”逐日明细并汇总；任何失败整体回滚，
   * 不留半套明细（simulateRecomputeFailure 用于验证失败重算场景）。
   */
  async trial(id: string, dto: TrialBillDto = {}) {
    try {
      return await this.dataSource.transaction(async (em) => {
        const bill = await this.getBillForUpdate(em, id);
        await this.lockMonth(em, bill.elderId, bill.billMonth);
        if (
          bill.status !== BillStatus.DRAFT &&
          bill.status !== BillStatus.TRIALED
        ) {
          throw new ConflictException({
            code: 'BILL_NOT_TRIALABLE',
            message: `账单当前状态 ${bill.status} 不可试算（仅草稿/已试算版本可试算）`,
          });
        }

        const { from, to } = this.monthRange(bill.billMonth);
        const periods = await loadLivePeriods(em, bill.elderId, from, to);
        const rates = await loadLiveRates(em);

        if (dto.simulateRecomputeFailure === true) {
          throw new RecomputeError(
            'RECOMPUTE_FAILED_INJECTED: 模拟逐日重算失败（明细保持回滚，不落半套）',
          );
        }

        let calc;
        try {
          calc = computeDaily(periods, rates, from, to);
        } catch (e: any) {
          throw new RecomputeError(
            `RECOMPUTE_FAILED: ${String(e?.message ?? e)}`,
          );
        }

        await this.replaceLines(em, bill.id, calc.days);

        bill.totalDays = calc.totalDays;
        bill.totalAmount = calc.totalAmount;
        bill.sourceFingerprint = fingerprintOf(periods, rates);
        bill.status = BillStatus.TRIALED;
        bill.lastRecomputeError = null;
        await em.save(bill);

        return {
          bill: this.serialize(bill),
          segments: calc.segments,
          daily: calc.days,
        };
      });
    } catch (e: any) {
      if (e instanceof RecomputeError) {
        await this.recordRecomputeError(id, e.message);
        throw new ConflictException({
          code: 'BILL_RECOMPUTE_FAILED',
          message: `试算/重算失败，已回滚且未改动既有明细：${e.message}`,
          billId: id,
        });
      }
      throw mapPersistenceError(e);
    }
  }

  /** 记录最近一次重算失败原因（独立事务；不改动金额与明细） */
  private async recordRecomputeError(id: string, message: string) {
    try {
      await this.dataSource.transaction(async (em) => {
        await em.query(
          `UPDATE monthly_bills SET last_recompute_error = $1, updated_at = now()
            WHERE id = $2 AND status IN ('DRAFT','TRIALED')`,
          [message, id],
        );
      });
    } catch {
      /* 错误记录失败不掩盖主异常 */
    }
  }

  // ---------------------------------------------------------------- 封账

  /**
   * 封账：
   *  1) 仅 TRIALED 可封（未试算/已封账/已重开/已替代均拒绝）；
   *  2) 试算后若等级期间或日费版本再变化（指纹不一致）→ 拒绝封账，要求重新试算；
   *  3) 冻结等级期间、日费版本、告知记录快照 + 逐日明细；
   *  4) 重开派生的新版本封账时，旧 REOPENED → SUPERSEDED 并关闭其开放建议。
   */
  async seal(id: string, dto: SealBillDto = {}) {
    return this.dataSource.transaction(async (em) => {
      const bill = await this.getBillForUpdate(em, id);
      await this.lockMonth(em, bill.elderId, bill.billMonth);

      switch (bill.status) {
        case BillStatus.DRAFT:
          throw new ConflictException({
            code: 'BILL_NOT_TRIALED',
            message: '草稿账单必须先试算才能封账',
          });
        case BillStatus.SEALED:
          throw new ConflictException({
            code: 'BILL_ALREADY_SEALED',
            message: `账单已封账（版本 v${bill.versionNo}），不得重复封账`,
            billId: bill.id,
          });
        case BillStatus.REOPENED:
          throw new ConflictException({
            code: 'BILL_ALREADY_REOPENED',
            message: '该版本已重开，请封账其派生的新版本',
          });
        case BillStatus.SUPERSEDED:
          throw new ConflictException({
            code: 'BILL_SUPERSEDED',
            message: '该版本已被新版本替代，不可封账',
          });
      }

      const { from, to } = this.monthRange(bill.billMonth);
      const periods = await loadLivePeriods(em, bill.elderId, from, to);
      const rates = await loadLiveRates(em);
      const notifications = await loadLiveNotifications(em, bill.elderId);
      const currentFingerprint = fingerprintOf(periods, rates);

      if (currentFingerprint !== bill.sourceFingerprint) {
        throw new ConflictException({
          code: 'BILL_SOURCE_CHANGED_AFTER_TRIAL',
          message:
            '试算后等级期间或日费版本发生变化，请重新试算确认后再封账（封账不得静默采用变化后数据）',
          trialFingerprint: bill.sourceFingerprint,
          currentFingerprint,
        });
      }

      // 封账前再次内存重算并与试算结果核对（防篡改/防漂移）
      const calc = computeDaily(periods, rates, from, to);
      if (
        calc.totalDays !== bill.totalDays ||
        calc.totalAmount !== moneyText(bill.totalAmount)
      ) {
        throw new ConflictException({
          code: 'BILL_SOURCE_CHANGED_AFTER_TRIAL',
          message: `封账重算结果（${calc.totalDays} 天 / ${calc.totalAmount}）与试算结果（${bill.totalDays} 天 / ${bill.totalAmount}）不一致，请重新试算`,
        });
      }
      const lineCheck = await this.verifyLinesComplete(
        em,
        bill.id,
        calc.totalDays,
        calc.totalAmount,
      );
      if (!lineCheck) {
        throw new ConflictException({
          code: 'BILL_LINES_INCOMPLETE',
          message: '逐日明细不完整或金额不一致，拒绝封账（请重新试算）',
        });
      }

      const snapshot = buildSnapshot({
        periods,
        rates,
        notifications,
        monthFrom: from,
        monthTo: to,
        sealedBy: dto.sealedBy ?? null,
        derivedFromBillId: bill.predecessorId,
      });

      bill.status = BillStatus.SEALED;
      bill.sealedSnapshot = snapshot;
      bill.sealedBy = dto.sealedBy ?? null;
      bill.sealedAt = new Date();
      bill.lastRecomputeError = null;
      await em.save(bill);

      // 新版本封账：旧 REOPENED → SUPERSEDED，其开放建议随之关闭
      if (bill.predecessorId) {
        const predecessor = await em.findOneBy(MonthlyBill, {
          id: bill.predecessorId,
        });
        if (predecessor && predecessor.status === BillStatus.REOPENED) {
          predecessor.status = BillStatus.SUPERSEDED;
          predecessor.successorId = bill.id;
          await em.save(predecessor);
          await em.query(
            `UPDATE bill_adjustment_suggestions
                SET status = 'SUPERSEDED',
                    superseded_by_bill_id = $1,
                    superseded_at = now()
              WHERE bill_id = $2 AND status = 'OPEN'`,
            [bill.id, predecessor.id],
          );
        }
      }

      return {
        bill: this.serialize(bill),
        snapshotSummary: this.snapshotSummary(snapshot),
      };
    });
  }

  // ---------------------------------------------------------------- 重开

  /**
   * 重开已封账版本（必须给出原因）：
   *  - 旧 SEALED → REOPENED（冻结快照与金额保留，重算失败时仍可查可用）；
   *  - 从旧快照/明细派生新版本 DRAFT（versionNo+1，逐日明细整行复制为基线）；
   *  - 并发重开由 advisory lock + 行锁 + 部分唯一索引共同拦截，第二个请求 409。
   * 返回新版本；调用方随后对新版本试算（当前实时数据）→ 封账。
   */
  async reopen(id: string, dto: ReopenBillDto) {
    const reason = dto.reason?.trim();
    if (!reason) {
      throw new ConflictException({
        code: 'REOPEN_REASON_REQUIRED',
        message: '重开必须填写原因',
      });
    }

    try {
      return await this.dataSource.transaction(async (em) => {
        const predecessor = await this.getBillForUpdate(em, id);
        await this.lockMonth(em, predecessor.elderId, predecessor.billMonth);

        if (predecessor.status !== BillStatus.SEALED) {
          if (predecessor.status === BillStatus.REOPENED) {
            throw new ConflictException({
              code: 'BILL_ALREADY_REOPENED',
              message: `版本 v${predecessor.versionNo} 已重开，不得并发/重复重开`,
              successorId: predecessor.successorId,
            });
          }
          if (predecessor.status === BillStatus.SUPERSEDED) {
            throw new ConflictException({
              code: 'BILL_SUPERSEDED',
              message: '该版本已被替代，不可重开',
            });
          }
          throw new ConflictException({
            code: 'BILL_NOT_SEALED',
            message: `账单当前状态 ${predecessor.status}，仅已封账版本可重开`,
          });
        }

        const versions = await this.findVersionsLocked(
          em,
          predecessor.elderId,
          predecessor.billMonth,
        );
        const nextVersionNo = Math.max(...versions.map((b) => b.versionNo)) + 1;

        // 新版本继承旧版本汇总作为基线；指纹取封账快照指纹
        const draft = em.create(MonthlyBill, {
          elderId: predecessor.elderId,
          billMonth: predecessor.billMonth,
          versionNo: nextVersionNo,
          status: BillStatus.DRAFT,
          totalAmount: predecessor.totalAmount,
          totalDays: predecessor.totalDays,
          sourceFingerprint:
            predecessor.sealedSnapshot?.fingerprint ??
            predecessor.sourceFingerprint,
          sealedSnapshot: null,
          predecessorId: predecessor.id,
          reopenReason: reason,
          reopenedBy: dto.reopenedBy ?? null,
          reopenedAt: new Date(),
        });
        await em.save(draft);

        // 从旧快照派生：逐日明细整行复制（旧账明细保持不动）
        await em.query(
          `INSERT INTO bill_daily_lines
               (id, bill_id, line_date, grade, daily_rate, amount, source,
                grade_period_id, rate_version_id, rate_effective_from, note, created_at)
             SELECT gen_random_uuid(), $1, line_date, grade, daily_rate, amount, source,
                    grade_period_id, rate_version_id, rate_effective_from, note, now()
               FROM bill_daily_lines WHERE bill_id = $2`,
          [draft.id, predecessor.id],
        );

        predecessor.status = BillStatus.REOPENED;
        predecessor.successorId = draft.id;
        predecessor.reopenReason = reason;
        predecessor.reopenedBy = dto.reopenedBy ?? null;
        predecessor.reopenedAt = new Date();
        await em.save(predecessor);

        return {
          predecessor: this.serialize(predecessor),
          bill: this.serialize(draft),
        };
      });
    } catch (e: any) {
      throw mapPersistenceError(e);
    }
  }

  // ---------------------------------------------------------------- 差异查询

  /**
   * 差异查询：封账快照口径 vs 当前实时数据口径，逐天比对并聚合为
   * 跨期调整建议（RATE_BACKFILL / GRADE_PERIOD_CHANGE）。
   * 幂等：同一账单重复查询不产生重复 OPEN 建议（先整体关闭旧 OPEN 再重建）。
   * 已封账/已重开/已替代版本均可查；草稿/试算版无快照，拒绝。
   */
  async diff(id: string) {
    return this.dataSource.transaction(async (em) => {
      const bill = await this.getBillForUpdate(em, id);
      const snapshot = bill.sealedSnapshot;
      if (!snapshot) {
        throw new ConflictException({
          code: 'BILL_NOT_SEALED',
          message: '账单尚无封账快照（未封账），无可比对的冻结基准',
        });
      }

      const sealedCalcInput = snapshotToCalc(snapshot);
      const sealedCalc = computeDaily(
        sealedCalcInput.periods,
        sealedCalcInput.rates,
        snapshot.monthFrom,
        snapshot.monthTo,
      );

      const livePeriods = await loadLivePeriods(
        em,
        bill.elderId,
        snapshot.monthFrom,
        snapshot.monthTo,
      );
      const liveRates = await loadLiveRates(em);
      const currentCalc = computeDaily(
        livePeriods,
        liveRates,
        snapshot.monthFrom,
        snapshot.monthTo,
      );

      const dayDiffs = diffDaily(sealedCalc.days, currentCalc.days);
      const aggregated = aggregateSuggestions(dayDiffs);

      const sealedTotal = sealedCalc.totalAmount;
      const currentTotal = currentCalc.totalAmount;
      const deltaAmount = moneyText(
        new Decimal(currentTotal).minus(sealedTotal),
      );

      // 已替代（SUPERSEDED）版本的差异已被后续封账版本吸收：
      // 不再增删建议，只读返回当时留痕的全部建议（OPEN/SUPERSEDED）。
      if (bill.status === BillStatus.SUPERSEDED) {
        const stored = await em.query(
          `SELECT id, bill_id, change_type, from_date, to_date, days,
                  sealed_amount, current_amount, delta_amount, reason, status,
                  superseded_by_bill_id, superseded_at, created_at
             FROM bill_adjustment_suggestions
            WHERE bill_id = $1 ORDER BY from_date`,
          [bill.id],
        );
        return {
          billId: bill.id,
          status: bill.status,
          billMonth: bill.billMonth,
          sealedTotalAmount: sealedTotal,
          currentTotalAmount: currentTotal,
          deltaAmount,
          absorbed: true,
          suggestions: stored.map((r: any) => this.serializeSuggestionRow(r)),
          daily: dayDiffs,
        };
      }

      // SEALED / REOPENED：重建 OPEN 建议（旧 OPEN 整体失效，
      // 例如补录后又被撤销/再次补录）。建议 id 由 (账单 + 业务键)
      // 经 uuid v5 确定性派生：同样的差异重复查询得到同一 id（幂等可回放）。
      await em.query(
        `DELETE FROM bill_adjustment_suggestions WHERE bill_id = $1 AND status = 'OPEN'`,
        [bill.id],
      );
      const suggestions: any[] = [];
      for (const a of aggregated) {
        const deterministicId = suggestionId(bill.id, a);
        const rows = await em.query(
          `INSERT INTO bill_adjustment_suggestions
             (id, bill_id, change_type, from_date, to_date, days,
              sealed_amount, current_amount, delta_amount, reason, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'OPEN', now())
           RETURNING *`,
          [
            deterministicId,
            bill.id,
            a.changeType,
            a.fromDate,
            a.toDate,
            a.days,
            a.sealedAmount,
            a.currentAmount,
            a.deltaAmount,
            a.reason,
          ],
        );
        suggestions.push(rows[0]);
      }

      return {
        billId: bill.id,
        status: bill.status,
        billMonth: bill.billMonth,
        sealedTotalAmount: sealedTotal,
        currentTotalAmount: currentTotal,
        deltaAmount,
        suggestions: suggestions.map((s) => this.serializeSuggestionRow(s)),
        daily: dayDiffs,
      };
    });
  }

  // ---------------------------------------------------------------- 查询

  async get(id: string) {
    const bill = await this.billRepo.findOneBy({ id });
    if (!bill) throw new NotFoundException('月度账单不存在');
    const lines = await this.lineRepo.find({
      where: { bill: { id } },
      order: { lineDate: 'ASC' },
    });
    return {
      bill: this.serialize(bill),
      snapshotSummary: bill.sealedSnapshot
        ? this.snapshotSummary(bill.sealedSnapshot)
        : null,
      daily: lines.map((l) => this.serializeLine(l)),
    };
  }

  async list(elderId?: string, billMonth?: string) {
    const bills = await this.billRepo.find({
      where: {
        ...(elderId ? { elderId } : {}),
        ...(billMonth ? { billMonth } : {}),
      },
      order: { elderId: 'ASC', billMonth: 'ASC', versionNo: 'ASC' },
    });
    return bills.map((b) => this.serialize(b));
  }

  /** 版本链回放：同一老人同一月份全部版本及派生关系 */
  async chain(elderId: string, billMonth: string) {
    this.monthRange(billMonth);
    const versions = await this.billRepo.find({
      where: { elderId, billMonth },
      order: { versionNo: 'ASC' },
    });
    if (!versions.length) throw new NotFoundException('该月份无账单版本');
    const sealed = versions.find((b) => b.status === BillStatus.SEALED);
    return {
      elderId,
      billMonth,
      inForceBillId: sealed?.id ?? null,
      versions: versions.map((b, i) => ({
        ...this.serialize(b),
        chainPosition: {
          isFirst: i === 0,
          isLatest: i === versions.length - 1,
          isInForce: b.status === BillStatus.SEALED,
        },
      })),
    };
  }

  async lines(id: string) {
    const bill = await this.billRepo.findOneBy({ id });
    if (!bill) throw new NotFoundException('月度账单不存在');
    const lines = await this.lineRepo.find({
      where: { bill: { id } },
      order: { lineDate: 'ASC' },
    });
    return {
      billId: id,
      status: bill.status,
      versionNo: bill.versionNo,
      billMonth: bill.billMonth,
      totalDays: bill.totalDays,
      totalAmount: moneyText(bill.totalAmount),
      daily: lines.map((l) => this.serializeLine(l)),
    };
  }

  async adjustments(status?: BillAdjustmentStatus, billId?: string) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (billId) {
      params.push(billId);
      where.push(`bill_id = $${params.length}`);
    }
    const rows = await this.dataSource.query(
      `SELECT id, bill_id, change_type, from_date, to_date, days,
              sealed_amount, current_amount, delta_amount, reason, status,
              superseded_by_bill_id, superseded_at, created_at
         FROM bill_adjustment_suggestions
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC`,
      params,
    );
    return rows.map((r: any) => this.serializeSuggestionRow(r));
  }

  // ---------------------------------------------------------------- 内部辅助

  /** 事务内整删整插逐日明细（先算后写，失败整体回滚） */
  private async replaceLines(
    em: EntityManager,
    billId: string,
    days: ReturnType<typeof computeDaily>['days'],
  ) {
    await em.query(`DELETE FROM bill_daily_lines WHERE bill_id = $1`, [billId]);
    if (!days.length) return;
    const values: string[] = [];
    const params: unknown[] = [billId];
    days.forEach((d, i) => {
      const base = 1 + i * 9;
      values.push(
        `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`,
      );
      params.push(
        d.date,
        d.grade,
        d.dailyRate,
        d.amount,
        d.source,
        d.gradePeriodId,
        d.rateVersionId,
        d.rateEffectiveFrom,
        d.note,
      );
    });
    await em.query(
      `INSERT INTO bill_daily_lines
         (bill_id, line_date, grade, daily_rate, amount, source,
          grade_period_id, rate_version_id, rate_effective_from, note)
       VALUES ${values.join(', ')}`,
      params,
    );
  }

  /** 校验已持久化明细：天数齐全、合计与账单一致（防半套明细封账） */
  private async verifyLinesComplete(
    em: EntityManager,
    billId: string,
    expectedDays: number,
    expectedAmount: string,
  ): Promise<boolean> {
    const rows = await em.query(
      `SELECT count(*)::int AS days, COALESCE(sum(amount),0)::text AS amount
         FROM bill_daily_lines WHERE bill_id = $1`,
      [billId],
    );
    return (
      rows[0].days === expectedDays &&
      moneyText(rows[0].amount) === moneyText(expectedAmount)
    );
  }

  // ---------------------------------------------------------------- 序列化

  private serialize(b: MonthlyBill) {
    return {
      id: b.id,
      elderId: b.elderId,
      billMonth: b.billMonth,
      versionNo: b.versionNo,
      status: b.status,
      totalDays: b.totalDays,
      totalAmount: moneyText(b.totalAmount),
      sourceFingerprint: b.sourceFingerprint,
      predecessorId: b.predecessorId,
      successorId: b.successorId,
      reopenReason: b.reopenReason,
      reopenedBy: b.reopenedBy,
      reopenedAt: iso(b.reopenedAt),
      sealedBy: b.sealedBy,
      sealedAt: iso(b.sealedAt),
      lastRecomputeError: b.lastRecomputeError,
      createdAt: iso(b.createdAt),
      updatedAt: iso(b.updatedAt),
      hasSnapshot: b.sealedSnapshot != null,
      inForce: b.status === BillStatus.SEALED,
    };
  }

  private serializeLine(l: BillDailyLine) {
    return {
      id: l.id,
      billId: (l.bill as MonthlyBill)?.id ?? undefined,
      date: textCol(l.lineDate),
      grade: l.grade,
      dailyRate: l.dailyRate != null ? moneyText(l.dailyRate) : null,
      amount: moneyText(l.amount),
      source: l.source,
      gradePeriodId: l.gradePeriodId,
      rateVersionId: l.rateVersionId,
      rateEffectiveFrom: l.rateEffectiveFrom
        ? textCol(l.rateEffectiveFrom)
        : null,
      note: l.note,
    };
  }

  /** 原生 SQL 返回的调整建议行（snake_case）序列化 */
  private serializeSuggestionRow(s: any) {
    return {
      id: s.id,
      billId: s.bill_id,
      changeType: s.change_type,
      fromDate: textCol(s.from_date),
      toDate: textCol(s.to_date),
      days: Number(s.days),
      sealedAmount: moneyText(s.sealed_amount),
      currentAmount: moneyText(s.current_amount),
      deltaAmount: moneyText(s.delta_amount),
      reason: s.reason,
      status: s.status,
      supersededByBillId: s.superseded_by_bill_id,
      supersededAt: iso(s.superseded_at),
      createdAt: iso(s.created_at),
    };
  }

  private snapshotSummary(s: BillSnapshot) {
    return {
      sealedAt: s.sealedAt,
      sealedBy: s.sealedBy,
      monthFrom: s.monthFrom,
      monthTo: s.monthTo,
      fingerprint: s.fingerprint,
      derivedFromBillId: s.derivedFromBillId,
      periodsCount: s.periods.length,
      ratesCount: s.rates.length,
      notificationsCount: s.notifications.length,
      notifications: s.notifications,
      periods: s.periods,
      rates: s.rates,
    };
  }
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function textCol(v: string | Date): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
}

/** 调整建议确定性 id 派生：账单 + 类型 + 日期段 + 封账/当前金额 */
const BILL_ADJ_NAMESPACE = '8f1c4b2a-7d3e-4a6f-9c2b-1e5d8a0f3b47';

function suggestionId(
  billId: string,
  a: {
    changeType: string;
    fromDate: string;
    toDate: string;
    sealedAmount: string;
    currentAmount: string;
  },
): string {
  return uuidV5(
    [
      billId,
      a.changeType,
      a.fromDate,
      a.toDate,
      moneyText(a.sealedAmount),
      moneyText(a.currentAmount),
    ].join('|'),
    BILL_ADJ_NAMESPACE,
  );
}

/** 唯一索引/约束冲突 → 可读的 409（并发防护的数据库防线） */
function mapPersistenceError(e: any): unknown {
  // 并发事务在 READ COMMITTED 下的锁冲突/唯一竞争
  if (e?.code === '40P01' || e?.code === '40001' || e?.code === '23505') {
    return new ConflictException({
      code: 'BILL_CONCURRENT_MODIFICATION',
      message:
        '账单并发修改冲突（重复封账/并发重开），仅一个请求生效，请刷新后重试',
    });
  }
  const name = e?.constraint ?? e?.message ?? '';
  if (/monthly_bills_one_sealed/.test(name)) {
    return new ConflictException({
      code: 'MONTH_ALREADY_SEALED',
      message: '同一月份只允许一个有效封账版本（数据库唯一约束拦截并发封账）',
    });
  }
  if (/monthly_bills_one_open/.test(name)) {
    return new ConflictException({
      code: 'BILL_OPEN_VERSION_EXISTS',
      message: '同一月份只允许一个开放中的账单版本（草稿/试算）',
    });
  }
  if (/monthly_bills_version_unique/.test(name)) {
    return new ConflictException({
      code: 'BILL_VERSION_CONFLICT',
      message: '账单版本号冲突（并发请求），请重试',
    });
  }
  return e;
}
