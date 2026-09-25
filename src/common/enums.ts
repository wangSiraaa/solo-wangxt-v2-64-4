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
 * 月度账单版本状态（版本链闭环）：
 * DRAFT 草稿 → TRIALED 已试算 → SEALED 已封账；
 * 封账后重开：旧版本 SEALED → REOPENED（已重开，冻结数据仍可查可用），
 *             同时从旧快照派生新版本 DRAFT；
 * 新版本封账：REOPENED 旧版本 → SUPERSEDED（已替代）。
 */
export enum BillStatus {
  DRAFT = 'DRAFT',
  TRIALED = 'TRIALED',
  SEALED = 'SEALED',
  REOPENED = 'REOPENED',
  SUPERSEDED = 'SUPERSEDED',
}

/** 逐日费用来源（账单明细沿用费用分段的来源口径） */
export enum BillLineSource {
  GRADE_PERIOD_AND_RATE = 'GRADE_PERIOD_AND_RATE',
  GRADE_PERIOD_NO_RATE = 'GRADE_PERIOD_NO_RATE',
  NO_EFFECTIVE_GRADE = 'NO_EFFECTIVE_GRADE',
}

/** 跨期调整建议的变化类型 */
export enum BillAdjustmentChangeType {
  /** 封账后补录/更正日费版本（等级不变，日费变化） */
  RATE_BACKFILL = 'RATE_BACKFILL',
  /** 封账后评估更正导致等级期间变化（等级变化） */
  GRADE_PERIOD_CHANGE = 'GRADE_PERIOD_CHANGE',
}

/** 调整建议状态：OPEN 待跨期处理；被后续封账版本吸收后 SUPERSEDED */
export enum BillAdjustmentStatus {
  OPEN = 'OPEN',
  SUPERSEDED = 'SUPERSEDED',
}
