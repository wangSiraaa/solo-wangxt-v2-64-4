import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BillStatus } from '../common/enums';

/**
 * 月度账单版本（版本链的一个节点）。
 *
 * 状态机：
 *   DRAFT（草稿）→ TRIALED（已试算）→ SEALED（已封账）
 * 封账后重开：
 *   旧 SEALED → REOPENED（已重开；冻结数据仍可查、仍可用作兜底），
 *   同时从旧快照派生新版本（versionNo+1）DRAFT；
 * 新版本封账：
 *   旧 REOPENED → SUPERSEDED（已替代），新版本 → SEALED。
 *
 * 数据库约束（ensureSchema 中 DDL）：
 *  - (elder_id, bill_month, version_no) 唯一：版本号链不重复；
 *  - 部分唯一索引：同一 elder+month 至多一个 SEALED；
 *  - 部分唯一索引：同一 elder+month 至多一个开放版本（DRAFT/TRIALED）；
 *  - 状态 CHECK + 版本链引用一致性由服务事务保证。
 */
@Entity('monthly_bills')
@Index(['elderId', 'billMonth', 'versionNo'], { unique: true })
@Index(['elderId', 'billMonth'])
export class MonthlyBill {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  /** 账单月份 YYYY-MM（始终为公历完整月） */
  @Column({ name: 'bill_month', type: 'varchar', length: 7 })
  billMonth: string;

  @Column({ name: 'version_no', type: 'int' })
  versionNo: number;

  @Column({ name: 'status', type: 'varchar', length: 20 })
  status: BillStatus;

  // ---- 金额/天数汇总（试算写入；封账冻结；重开新版本重算） ----
  @Column({ name: 'total_amount', type: 'numeric', precision: 14, scale: 2 })
  totalAmount: string;

  @Column({ name: 'total_days', type: 'int' })
  totalDays: number;

  /** 试算/重算的来源指纹（期间+日费版本规范化哈希）；封账时校验来源未再变化 */
  @Column({ name: 'source_fingerprint', type: 'varchar', length: 64 })
  sourceFingerprint: string;

  /**
   * 封账快照（jsonb）：封账时刻冻结，后续数据变化绝不改写。
   * { periods: [...], rates: [...], notifications: [...], sealedAt, ... }
   * 重开时新版本从此快照派生；差异查询以它为“旧账”基准。
   * 草稿/试算阶段为 null。
   */
  @Column({ name: 'sealed_snapshot', type: 'jsonb', nullable: true })
  sealedSnapshot: BillSnapshot | null;

  // ---- 版本链 ----
  /** 重开派生时指向被重开的旧版本 */
  @Column({ name: 'predecessor_id', type: 'uuid', nullable: true })
  predecessorId: string | null;

  /** 新版本封账后，回填到旧 REOPENED 行 */
  @Column({ name: 'successor_id', type: 'uuid', nullable: true })
  successorId: string | null;

  /** 重开原因（重开必填；服务层 + CHECK 约束双重保证） */
  @Column({ name: 'reopen_reason', type: 'text', nullable: true })
  reopenReason: string | null;

  @Column({ name: 'reopened_by', type: 'varchar', length: 64, nullable: true })
  reopenedBy: string | null;

  @Column({ name: 'reopened_at', type: 'timestamptz', nullable: true })
  reopenedAt: Date | null;

  @Column({ name: 'sealed_by', type: 'varchar', length: 64, nullable: true })
  sealedBy: string | null;

  @Column({ name: 'sealed_at', type: 'timestamptz', nullable: true })
  sealedAt: Date | null;

  /** 最近一次试算/重算失败原因（失败不留半套明细，仅记录错误供排查） */
  @Column({ name: 'last_recompute_error', type: 'text', nullable: true })
  lastRecomputeError: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** 封账快照结构（同时用于重开派生与差异回放） */
export interface BillSnapshot {
  sealedAt: string;
  sealedBy: string | null;
  monthFrom: string;
  monthTo: string;
  /** 冻结的等级期间（与月内逐日覆盖相关的全部期间） */
  periods: SnapshotPeriod[];
  /** 冻结的全部日费版本（按等级×生效日） */
  rates: SnapshotRate[];
  /** 冻结的告知记录快照（按老人维度，含各案件的告知状态） */
  notifications: SnapshotNotification[];
  /** 快照来源指纹（与 source_fingerprint 一致，便于离线核对） */
  fingerprint: string;
  /** 重开派生链：首版封账为 0；重开版本记录其来源封账版本 id */
  derivedFromBillId: string | null;
}

export interface SnapshotPeriod {
  id: string;
  grade: string;
  startDate: string;
  endDateExclusive: string | null;
  sourceCaseId: string;
}

export interface SnapshotRate {
  id: string;
  grade: string;
  effectiveFrom: string;
  dailyRate: string;
  note: string | null;
}

export interface SnapshotNotification {
  id: string;
  assessmentCaseId: string;
  status: string;
  notifiableStatus: string;
  message: string | null;
  failureReason: string | null;
  attempts: number;
  createdAt: string | null;
  lastAttemptAt: string | null;
}
