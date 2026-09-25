import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BillStatus } from '../common/enums';

/**
 * 月度账单（按老人 × 自然月）。
 *
 * 状态机：DRAFT → TRIALED → CLOSED → REOPENED（旧版定格，派生新版 TRIALED）
 *                              └→ SUPERSEDED（被新版本封账替代）
 *
 * 不变量（数据库部分唯一索引为最终防线，服务层事务+行锁先行）：
 *  - 同老人同月份任意时刻最多一个“工作版本”（DRAFT/TRIALED）；
 *  - 同老人同月份任意时刻最多一个“有效封账”（CLOSED）；
 *  - (elder_id, bill_month, version_no) 唯一；
 *  - 封账后冻结快照，金额只随新版本变化，旧版绝不静默改写。
 */
@Entity('monthly_bills')
@Index(['elderId', 'billMonth', 'versionNo'], { unique: true })
export class MonthlyBill {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  /** 账单月份 YYYY-MM（自然月，含闰月 29 天） */
  @Column({ name: 'bill_month', type: 'varchar', length: 7 })
  billMonth: string;

  /** 账期首日/末日（由 billMonth 按日历推导，闰月自动 29 天） */
  @Column({ name: 'period_start', type: 'date' })
  periodStart: string;

  @Column({ name: 'period_end', type: 'date' })
  periodEnd: string;

  /** 版本号，从 1 起；重开派生 version_no+1 */
  @Column({ name: 'version_no', type: 'int' })
  versionNo: number;

  @Column({ name: 'status', type: 'varchar', length: 20 })
  status: BillStatus;

  /** 月度合计（numeric，decimal.js 逐天累加，两位小数） */
  @Column({ name: 'total_amount', type: 'numeric', precision: 14, scale: 2, default: 0 })
  totalAmount: string;

  @Column({ name: 'total_days', type: 'int', default: 0 })
  totalDays: number;

  /**
   * 封账快照（CLOSED/SUPERSEDED/REOPENED 非空，TRIALED 为 null）：
   *  - gradePeriods：账期内等级期间冻结副本（id/grade/区间/来源案件）
   *  - rateVersions：账期涉及的日费版本冻结副本（id/grade/生效日/日费/note）
   *  - notifications：账期内家属告知冻结副本（id/status/notifiableStatus/attempts）
   *  - frozenAt：冻结时刻
   */
  @Column({ name: 'snapshot', type: 'jsonb', nullable: true })
  snapshot: BillSnapshot | null;

  /** 重开原因（REOPENED/SUPERSEDED 旧版非空） */
  @Column({ name: 'reopen_reason', type: 'text', nullable: true })
  reopenReason: string | null;

  /** 版本链：本版本派生自哪个封账版本（v1 为 null） */
  @ManyToOne(() => MonthlyBill, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'derived_from_bill_id' })
  derivedFromBill: MonthlyBill | null;

  @Column({ name: 'derived_from_bill_id', type: 'uuid', nullable: true })
  derivedFromBillId: string | null;

  /** 最新后续版本（版本链正向指针，便于回放；可为 null） */
  @ManyToOne(() => MonthlyBill, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'superseded_by_bill_id' })
  supersededByBill: MonthlyBill | null;

  @Column({ name: 'superseded_by_bill_id', type: 'uuid', nullable: true })
  supersededByBillId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

export interface BillGradePeriodSnapshot {
  id: string;
  grade: string;
  startDate: string;
  endDateExclusive: string | null;
  sourceCaseId: string;
}

export interface BillRateVersionSnapshot {
  id: string;
  grade: string;
  effectiveFrom: string;
  dailyRate: string;
  note: string | null;
}

export interface BillNotificationSnapshot {
  id: string;
  status: string;
  notifiableStatus: string;
  attempts: number;
  lastAttemptAt: string | null;
  failureReason: string | null;
  message: string | null;
  createdAt: string;
}

export interface BillSnapshot {
  frozenAt: string;
  gradePeriods: BillGradePeriodSnapshot[];
  rateVersions: BillRateVersionSnapshot[];
  notifications: BillNotificationSnapshot[];
}
