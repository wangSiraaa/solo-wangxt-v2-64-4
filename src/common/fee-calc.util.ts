/**
 * 逐日计费纯函数：账单封账/试算与 /fees/segments 共用同一口径，
 * 输入既可以来自实时表，也可以来自封账快照（账单回放）。
 *
 * 所有日期统一 'YYYY-MM-DD' 纯字符串；金额统一 decimal.js 两位小数。
 */
import Decimal from 'decimal.js';
import { GradeCode } from './enums';
import { addDays, diffDays, isValidDate } from './date.util';
import { dailyTimesRate, moneyText } from './money.util';

export interface CalcPeriod {
  id: string;
  grade: GradeCode;
  startDate: string;
  endDateExclusive: string | null;
  /** 来源评估案件（账单快照追溯用；计费本身不依赖） */
  sourceCaseId?: string;
}

export interface CalcRate {
  id: string;
  grade: GradeCode;
  effectiveFrom: string;
  dailyRate: string;
  note: string | null;
}

export type CalcLineSource =
  'GRADE_PERIOD_AND_RATE' | 'GRADE_PERIOD_NO_RATE' | 'NO_EFFECTIVE_GRADE';

/** 逐天明细：月内每一天一行，是封账快照的最小计费单元 */
export interface DailyLine {
  date: string;
  grade: GradeCode | null;
  dailyRate: string | null;
  amount: string;
  source: CalcLineSource;
  gradePeriodId: string | null;
  rateVersionId: string | null;
  rateEffectiveFrom: string | null;
  note: string;
}

export interface Segment {
  startDate: string;
  endDate: string;
  days: number;
  grade: GradeCode | null;
  dailyRate: string | null;
  amount: string;
  source: CalcLineSource;
  gradePeriodId: string | null;
  rateEffectiveFrom: string | null;
  note: string;
}

export interface FeeCalcResult {
  days: DailyLine[];
  segments: Segment[];
  totalDays: number;
  totalAmount: string;
}

function normalizeDate(v: string | Date): string {
  if (v instanceof Date) {
    // date 列驱动可能返回 UTC 0 点的 Date
    return v.toISOString().slice(0, 10);
  }
  return String(v);
}

/** 找到某日生效的等级期间（返回 null 表示当天无生效等级空洞） */
function periodAt(periods: CalcPeriod[], day: string): CalcPeriod | null {
  for (const p of periods) {
    const start = normalizeDate(p.startDate);
    const end = p.endDateExclusive ? normalizeDate(p.endDateExclusive) : null;
    if (start <= day && (end === null || day < end)) return p;
  }
  return null;
}

/** 找到某日某等级生效的日费版本（取 effectiveFrom <= day 的最新版本） */
function rateAt(
  rates: CalcRate[],
  grade: GradeCode,
  day: string,
): CalcRate | null {
  let hit: CalcRate | null = null;
  for (const r of rates) {
    if (r.grade !== grade) continue;
    if (normalizeDate(r.effectiveFrom) <= day) {
      if (
        !hit ||
        normalizeDate(r.effectiveFrom) > normalizeDate(hit.effectiveFrom)
      ) {
        hit = r;
      }
    }
  }
  return hit;
}

/**
 * 逐天计费（闭区间 [from,to]，含首尾；含闰月边界）：
 *  - 无生效等级的天：NO_EFFECTIVE_GRADE，金额 0；
 *  - 有等级无日费：GRADE_PERIOD_NO_RATE，金额 0；
 *  - 等级 × 日费版本：GRADE_PERIOD_AND_RATE，天数守恒。
 */
export function computeDaily(
  periods: CalcPeriod[],
  rates: CalcRate[],
  from: string,
  to: string,
): FeeCalcResult {
  if (!isValidDate(from) || !isValidDate(to) || from > to) {
    throw new Error('INVALID_RANGE: 查询区间日期不合法或起止倒置');
  }

  const days: DailyLine[] = [];
  let total = new Decimal(0);

  for (let day = from; day <= to; day = addDays(day, 1)) {
    const p = periodAt(periods, day);
    if (!p) {
      days.push({
        date: day,
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

    const r = rateAt(rates, p.grade, day);
    if (!r) {
      days.push({
        date: day,
        grade: p.grade,
        dailyRate: null,
        amount: moneyText(0),
        source: 'GRADE_PERIOD_NO_RATE',
        gradePeriodId: p.id,
        rateVersionId: null,
        rateEffectiveFrom: null,
        note: `等级 ${p.grade} 已生效但机构示例规则未定义日费：暂不计费`,
      });
      continue;
    }

    const amount = dailyTimesRate(r.dailyRate, 1);
    total = total.plus(amount);
    days.push({
      date: day,
      grade: p.grade,
      dailyRate: moneyText(r.dailyRate),
      amount: moneyText(amount),
      source: 'GRADE_PERIOD_AND_RATE',
      gradePeriodId: p.id,
      rateVersionId: r.id,
      rateEffectiveFrom: normalizeDate(r.effectiveFrom),
      note: `${p.grade} 等级期间 × 日费版本自 ${normalizeDate(r.effectiveFrom)} 起（${r.note ?? ''}）`,
    });
  }

  // 天数守恒：逐日行数必须等于区间天数
  const expected = diffDays(to, from) + 1;
  if (days.length !== expected) {
    throw new Error(
      `费用逐日行数不一致：逐日 ${days.length} 天，区间 ${expected} 天`,
    );
  }

  return {
    days,
    segments: aggregateSegments(days),
    totalDays: expected,
    totalAmount: moneyText(total),
  };
}

/**
 * 将逐日明细折叠成对外解释用的分段（沿用旧 /fees/segments 口径）：
 * 相邻且等级、日费版本、来源均相同的天合并为一段。
 */
export function aggregateSegments(days: DailyLine[]): Segment[] {
  const segments: Segment[] = [];
  for (const d of days) {
    const last = segments[segments.length - 1];
    if (
      last &&
      last.grade === d.grade &&
      last.dailyRate === d.dailyRate &&
      last.source === d.source &&
      last.gradePeriodId === d.gradePeriodId &&
      last.rateEffectiveFrom === d.rateEffectiveFrom &&
      addDays(last.endDate, 1) === d.date
    ) {
      last.endDate = d.date;
      last.days += 1;
      last.amount = moneyText(new Decimal(last.amount).plus(d.amount));
      continue;
    }
    segments.push({
      startDate: d.date,
      endDate: d.date,
      days: 1,
      grade: d.grade,
      dailyRate: d.dailyRate,
      amount: d.amount,
      source: d.source,
      gradePeriodId: d.gradePeriodId,
      rateEffectiveFrom: d.rateEffectiveFrom,
      note: d.note,
    });
  }
  return segments;
}

