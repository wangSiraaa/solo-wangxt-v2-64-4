import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  BillAdjustmentChangeType,
  BillAdjustmentStatus,
} from '../common/enums';
import { MonthlyBill } from './monthly-bill.entity';

/**
 * 跨期调整建议：已封账账单不得静默改写。
 * 封账后若发生评估更正（等级期间变化）或费率补录（日费版本变化），
 * 差异查询（/bills/:id/diff）按“封账快照 vs 当前实时数据”逐日比对，
 * 把相邻、同类型、同金额方向的天聚合成一条调整建议落库：
 *  - 只生成建议，原封账金额与逐日明细保持不变；
 *  - 后续重开并封账新版本吸收差异后，旧建议置 SUPERSEDED。
 *
 * 去重：(bill_id, change_type, from_date, to_date, sealed_amount, current_amount)
 * 部分唯一（仅 OPEN），重复差异查询不产生重复建议。
 */
@Entity('bill_adjustment_suggestions')
export class BillAdjustmentSuggestion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => MonthlyBill, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bill_id' })
  bill: MonthlyBill;

  @Column({ name: 'change_type', type: 'varchar', length: 32 })
  changeType: BillAdjustmentChangeType;

  /** 建议覆盖的起、止日（闭区间，相邻同差异天聚合） */
  @Column({ name: 'from_date', type: 'date' })
  fromDate: string;

  @Column({ name: 'to_date', type: 'date' })
  toDate: string;

  @Column({ name: 'days', type: 'int' })
  days: number;

  /** 封账快照口径金额（旧账，冻结值） */
  @Column({ name: 'sealed_amount', type: 'numeric', precision: 12, scale: 2 })
  sealedAmount: string;

  /** 当前实时数据口径金额（重算值） */
  @Column({ name: 'current_amount', type: 'numeric', precision: 12, scale: 2 })
  currentAmount: string;

  /** 差额 current - sealed（正补收/负退减；两位小数字符串） */
  @Column({ name: 'delta_amount', type: 'numeric', precision: 12, scale: 2 })
  deltaAmount: string;

  @Column({ name: 'reason', type: 'text' })
  reason: string;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 20,
    default: BillAdjustmentStatus.OPEN,
  })
  status: BillAdjustmentStatus;

  /** 吸收该建议的后续封账版本 */
  @Column({ name: 'superseded_by_bill_id', type: 'uuid', nullable: true })
  supersededByBillId: string | null;

  @Column({ name: 'superseded_at', type: 'timestamptz', nullable: true })
  supersededAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
