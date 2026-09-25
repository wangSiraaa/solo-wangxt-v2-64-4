/** 评估案件状态：必填项缺失不得定级；冲突进入复核而非自动取高 */
export enum CaseStatus {
  /** 评估员答案缺失必填项，无法定级，需补充/重新评估 */
  INCOMPLETE = 'INCOMPLETE',
  /** 两位评估员等级一致，系统确认（系统生成“一致确认”复核记录） */
  CONFIRMED = 'CONFIRMED',
  /** 两位评估员结果冲突，等待管理复核 */
  PENDING_REVIEW = 'PENDING_REVIEW',
}

export enum GradeCode {
  LIGHT = 'LIGHT', // 轻度失能
  MODERATE = 'MODERATE', // 中度失能
  SEVERE = 'SEVERE', // 重度失能
}

export enum ReviewResult {
  /** 双评估员一致，系统直接确认 */
  AGREEMENT = 'AGREEMENT',
  /** 冲突案件由管理员复核确认 */
  CONFIRMED = 'CONFIRMED',
}

export enum NotificationStatus {
  /** 等级已确认，待送达 */
  PENDING = 'PENDING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
}

export enum NotifiableStatus {
  CONFIRMED = 'CONFIRMED',
  UNCONFIRMED = 'UNCONFIRMED',
}

/** 量表不适用项（NA）如何影响分母：由量表版本自行定义 */
export enum NaPolicy {
  /** NA 项从分母中剔除 */
  EXCLUDE_FROM_DENOMINATOR = 'EXCLUDE_FROM_DENOMINATOR',
  /** NA 按 0 分计入分母（本演示量表不使用，仅展示枚举完整性） */
  COUNT_AS_ZERO = 'COUNT_AS_ZERO',
}

/**
 * 月度账单状态（封账闭环）：
 *   DRAFT     草稿：已建单尚未试算（事务中间态，正常流程会直接进入 TRIALED）
 *   TRIALED   已试算：逐日明细按当前数据算出，可反复重算，尚未冻结
 *   CLOSED    已封账：期间/费率/告知/逐日明细全部快照冻结，金额不可变
 *   REOPENED  已重开：封账后给出原因重开，旧版定格、由快照派生出下一版本（TRIALED）
 *   SUPERSEDED 已替代：被后续封账版本替代的旧封账（版本链上仅最新封账有效）
 */
export enum BillStatus {
  DRAFT = 'DRAFT',
  TRIALED = 'TRIALED',
  CLOSED = 'CLOSED',
  REOPENED = 'REOPENED',
  SUPERSEDED = 'SUPERSEDED',
}

/** 账单生命周期事件类型（审计留痕，重放版本链/调整关系用） */
export enum BillEventType {
  TRIALED = 'TRIALED',
  CLOSED = 'CLOSED',
  REOPENED = 'REOPENED',
  SUPERSEDED = 'SUPERSEDED',
  ADJUSTMENT_PROPOSED = 'ADJUSTMENT_PROPOSED',
  ADJUSTMENT_INCORPORATED = 'ADJUSTMENT_INCORPORATED',
  RECOMPUTE_FAILED = 'RECOMPUTE_FAILED',
}

/** 封账后差异产生的调整建议类型：后续数据变化不改账，只提调整 */
export enum AdjustmentType {
  /** 费率补录/变更导致的金额差异（等级未变） */
  RATE_CHANGED = 'RATE_CHANGED',
  /** 评估更正/等级期间变化导致的金额差异 */
  GRADE_CHANGED = 'GRADE_CHANGED',
}

/** 调整建议状态 */
export enum AdjustmentStatus {
  /** 待处理：差异仍开放，等待重开重算或人工处理 */
  OPEN = 'OPEN',
  /** 已纳入：重开派生的新版本已封账，建议并入新版本 */
  INCORPORATED = 'INCORPORATED',
}
