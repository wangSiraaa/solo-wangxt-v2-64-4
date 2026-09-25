/**
 * 账单“来源数据”加载与封账快照：
 *  - 实时来源：等级期间 + 日费版本 + 告知记录（试算/差异查询用）；
 *  - 快照来源：封账冻结的 jsonb（重开派生/差异旧账/重启回放用）。
 * 两条来源产出同一套 CalcPeriod/CalcRate，确保 computeDaily 口径一致。
 */
import { createHash } from 'crypto';
import { EntityManager } from 'typeorm';
import {
  BillSnapshot,
  SnapshotNotification,
  SnapshotPeriod,
  SnapshotRate,
} from '../entities/monthly-bill.entity';
import { CalcPeriod, CalcRate } from '../common/fee-calc.util';

export function textDate(v: string | Date): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
}

/** 加载老人与某月相关的等级期间（取全部相交期间，含月前开始的开放区间） */
export async function loadLivePeriods(
  em: EntityManager,
  elderId: string,
  monthFrom: string,
  monthTo: string,
): Promise<CalcPeriod[]> {
  const rows = await em.query(
    `SELECT id, grade,
            start_date::text AS start_date,
            end_date_exclusive::text AS end_date_exclusive,
            source_case_id
       FROM grade_periods
      WHERE elder_id = $1
        AND (end_date_exclusive IS NULL OR start_date <= $3)
        AND (end_date_exclusive IS NULL OR end_date_exclusive > $2)
      ORDER BY start_date`,
    [elderId, monthFrom, monthTo],
  );
  return rows.map((r: any) => ({
    id: r.id,
    grade: r.grade,
    startDate: r.start_date,
    endDateExclusive: r.end_date_exclusive,
    sourceCaseId: r.source_case_id,
  }));
}

/** 加载全部日费版本（封账冻结的是全量版本表，避免未来补录污染判断依据缺失） */
export async function loadLiveRates(em: EntityManager): Promise<CalcRate[]> {
  const rows = await em.query(
    `SELECT id, grade, effective_from::text AS effective_from,
            daily_rate::text AS daily_rate, note
       FROM fee_rate_versions
      ORDER BY grade, effective_from`,
  );
  return rows.map((r: any) => ({
    id: r.id,
    grade: r.grade,
    effectiveFrom: r.effective_from,
    dailyRate: r.daily_rate,
    note: r.note,
  }));
}

/** 加载老人维度的全部告知记录（跨案件，按时间排序） */
export async function loadLiveNotifications(
  em: EntityManager,
  elderId: string,
): Promise<SnapshotNotification[]> {
  const rows = await em.query(
    `SELECT n.id, n.assessment_case_id, n.status, n.notifiable_status,
            n.message, n.failure_reason, n.attempts,
            to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SSZ') AS created_at,
            to_char(n.last_attempt_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SSZ') AS last_attempt_at
       FROM notification_records n
       JOIN assessment_cases c ON c.id = n.assessment_case_id
      WHERE c.elder_id = $1
      ORDER BY n.created_at, n.id`,
    [elderId],
  );
  return rows.map((r: any) => ({
    id: r.id,
    assessmentCaseId: r.assessment_case_id,
    status: r.status,
    notifiableStatus: r.notifiable_status,
    message: r.message,
    failureReason: r.failure_reason,
    attempts: Number(r.attempts),
    createdAt: r.created_at,
    lastAttemptAt: r.last_attempt_at,
  }));
}

/**
 * 来源指纹：规范化（排序+定值序列化）后 SHA-256。
 * 试算与封账之间指纹一致 = 期间/费率未再变化；不一致拒绝静默封账。
 * 告知记录不进指纹（告知补送不应阻塞封账，但其快照仍被冻结）。
 */
export function fingerprintOf(
  periods: CalcPeriod[],
  rates: CalcRate[],
): string {
  const p = periods
    .map((x) => ({
      id: x.id,
      grade: x.grade,
      s: textDate(x.startDate),
      e: x.endDateExclusive ? textDate(x.endDateExclusive) : null,
    }))
    .sort((a, b) => (a.s + a.id < b.s + b.id ? -1 : 1));
  const r = rates
    .map((x) => ({
      id: x.id,
      grade: x.grade,
      f: textDate(x.effectiveFrom),
      rate: x.dailyRate,
    }))
    .sort((a, b) => (a.grade + a.f + a.id < b.grade + b.f + b.id ? -1 : 1));
  return createHash('sha256').update(JSON.stringify({ p, r })).digest('hex');
}

/** 封账时刻构造不可变快照（来源行原样冻结，金额口径以逐日明细为准） */
export function buildSnapshot(params: {
  periods: CalcPeriod[];
  rates: CalcRate[];
  notifications: SnapshotNotification[];
  monthFrom: string;
  monthTo: string;
  sealedBy: string | null;
  derivedFromBillId: string | null;
}): BillSnapshot {
  const periods: SnapshotPeriod[] = params.periods.map((p) => ({
    id: p.id,
    grade: p.grade,
    startDate: textDate(p.startDate),
    endDateExclusive: p.endDateExclusive ? textDate(p.endDateExclusive) : null,
    sourceCaseId: p.sourceCaseId ?? '',
  }));
  const rates: SnapshotRate[] = params.rates.map((r) => ({
    id: r.id,
    grade: r.grade,
    effectiveFrom: textDate(r.effectiveFrom),
    dailyRate: r.dailyRate,
    note: r.note,
  }));
  return {
    sealedAt: new Date().toISOString(),
    sealedBy: params.sealedBy,
    monthFrom: params.monthFrom,
    monthTo: params.monthTo,
    periods,
    rates,
    notifications: params.notifications,
    fingerprint: fingerprintOf(params.periods, params.rates),
    derivedFromBillId: params.derivedFromBillId,
  };
}

/** 快照 → 计费输入（重开派生新版本、差异查询旧账口径使用） */
export function snapshotToCalc(snapshot: BillSnapshot): {
  periods: CalcPeriod[];
  rates: CalcRate[];
} {
  return {
    periods: snapshot.periods.map((p) => ({
      id: p.id,
      grade: p.grade as CalcPeriod['grade'],
      startDate: p.startDate,
      endDateExclusive: p.endDateExclusive,
      sourceCaseId: p.sourceCaseId,
    })),
    rates: snapshot.rates.map((r) => ({
      id: r.id,
      grade: r.grade as CalcRate['grade'],
      effectiveFrom: r.effectiveFrom,
      dailyRate: r.dailyRate,
      note: r.note,
    })),
  };
}
