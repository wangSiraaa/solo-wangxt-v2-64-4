/**
 * 跨期差异引擎：
 * 已封账金额永不改写；封账后的评估更正（等级期间变化）或费率补录（日费变化），
 * 通过“封账快照逐日明细 vs 当前实时数据逐日重算”逐天比对产出。
 *
 * 变化类型按天判定：
 *  - grade 或 gradePeriodId 变化 → GRADE_PERIOD_CHANGE（评估更正）
 *  - 等级相同但日费/费率版本变化 → RATE_BACKFILL（费率补录）
 * 金额无变化的天不产生建议；相邻、同类型且差额同向的天聚合成一条建议。
 */
import Decimal from 'decimal.js';
import { DailyLine } from '../common/fee-calc.util';
import { moneyText } from '../common/money.util';
import { BillAdjustmentChangeType } from '../common/enums';

export interface DayDiff {
  date: string;
  changeType: BillAdjustmentChangeType;
  sealedGrade: string | null;
  currentGrade: string | null;
  sealedAmount: string;
  currentAmount: string;
  deltaAmount: string;
  sealedRate: string | null;
  currentRate: string | null;
}

export interface AggregatedSuggestion {
  changeType: BillAdjustmentChangeType;
  fromDate: string;
  toDate: string;
  days: number;
  sealedAmount: string;
  currentAmount: string;
  deltaAmount: string;
  reason: string;
  daily: DayDiff[];
}

export function classifyDay(
  sealed: DailyLine,
  current: DailyLine,
): BillAdjustmentChangeType | null {
  if (
    sealed.grade !== current.grade ||
    sealed.gradePeriodId !== current.gradePeriodId
  ) {
    return BillAdjustmentChangeType.GRADE_PERIOD_CHANGE;
  }
  if (sealed.dailyRate !== current.dailyRate) {
    return BillAdjustmentChangeType.RATE_BACKFILL;
  }
  return null;
}

/** 逐日比对，返回有金额/等级差异的天 */
export function diffDaily(
  sealedDays: DailyLine[],
  currentDays: DailyLine[],
): DayDiff[] {
  const currentByDate = new Map(currentDays.map((d) => [d.date, d]));
  const out: DayDiff[] = [];
  for (const s of sealedDays) {
    const c = currentByDate.get(s.date);
    if (!c) continue; // 理论上月份相同不会缺天
    const type = classifyDay(s, c);
    const delta = new Decimal(c.amount).minus(s.amount);
    if (!type || delta.isZero()) continue;
    out.push({
      date: s.date,
      changeType: type,
      sealedGrade: s.grade,
      currentGrade: c.grade,
      sealedAmount: moneyText(s.amount),
      currentAmount: moneyText(c.amount),
      deltaAmount: moneyText(delta),
      sealedRate: s.dailyRate,
      currentRate: c.dailyRate,
    });
  }
  return out;
}

/** 相邻、同类型、同差额方向的天聚合成一条建议 */
export function aggregateSuggestions(
  dayDiffs: DayDiff[],
): AggregatedSuggestion[] {
  const sorted = [...dayDiffs].sort((a, b) => (a.date < b.date ? -1 : 1));
  const groups: DayDiff[][] = [];
  for (const d of sorted) {
    const lastGroup = groups[groups.length - 1];
    const prev = lastGroup?.[lastGroup.length - 1];
    const sameDirection =
      prev &&
      new Decimal(prev.deltaAmount).greaterThan(0) ===
        new Decimal(d.deltaAmount).greaterThan(0);
    if (
      prev &&
      prev.changeType === d.changeType &&
      sameDirection &&
      addOneDay(prev.date) === d.date
    ) {
      lastGroup.push(d);
    } else {
      groups.push([d]);
    }
  }

  return groups.map((g) => {
    const sealed = g.reduce(
      (acc, d) => acc.plus(d.sealedAmount),
      new Decimal(0),
    );
    const current = g.reduce(
      (acc, d) => acc.plus(d.currentAmount),
      new Decimal(0),
    );
    const delta = current.minus(sealed);
    const first = g[0];
    return {
      changeType: first.changeType,
      fromDate: first.date,
      toDate: g[g.length - 1].date,
      days: g.length,
      sealedAmount: moneyText(sealed),
      currentAmount: moneyText(current),
      deltaAmount: moneyText(delta),
      reason: reasonFor(first.changeType, g, moneyText(delta)),
      daily: g,
    };
  });
}

function reasonFor(
  type: BillAdjustmentChangeType,
  g: DayDiff[],
  deltaText: string,
): string {
  const head = g[0];
  if (type === BillAdjustmentChangeType.RATE_BACKFILL) {
    return (
      `封账后费率补录：日费 ${head.sealedRate ?? '无'} → ${head.currentRate ?? '无'}，` +
      `共 ${g.length} 天，差额 ${deltaText} 元（仅生成跨期调整建议，原封账金额不变）`
    );
  }
  return (
    `封账后评估更正：等级 ${head.sealedGrade ?? '无'} → ${head.currentGrade ?? '无'}，` +
    `共 ${g.length} 天，差额 ${deltaText} 元（仅生成跨期调整建议，原封账金额不变）`
  );
}

function addOneDay(s: string): string {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}
