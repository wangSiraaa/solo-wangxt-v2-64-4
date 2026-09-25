import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  AdjustmentStatus,
  AdjustmentType,
} from '../common/enums';
import { MonthlyBill } from './monthly-bill.entity';

/**
 * 跨期调整建议：封账后数据变化（费率补录、评估更正）**绝不静默改写已封账金额**，
 * 差异只作为建议挂在原封账版本上；重开派生的新版本封账后，建议状态置为 INCORPORATED。
 *
 * 唯一约束 bill_adjustment_suggestions_one_open
 * （同封账 + 类型 + 自然日仅一条 OPEN）由持久化迁移显式创建。
 */
@Entity('bill_adjustment_suggestions')
export class BillAdjustmentSuggestion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => MonthlyBill, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bill_id' })
  bill: MonthlyBill;

  @Column({ name: 'bill_id', type: 'uuid' })
  billId: string;

  @Column({ name: 'adjustment_type', type: 'varchar', length: 20 })
  adjustmentType: AdjustmentType;

  /** 差异对应的自然日 */
  @Column({ name: 'line_date', type: 'date' })
  lineDate: string;

  /** 封账快照当天金额（来自冻结明细） */
  @Column({ name: 'frozen_amount', type: 'numeric', precision: 12, scale: 2 })
  frozenAmount: string;

  /** 当前数据重算当天金额 */
  @Column({ name: 'current_amount', type: 'numeric', precision: 12, scale: 2 })
  currentAmount: string;

  /** currentAmount - frozenAmount（正补收/负退减） */
  @Column({ name: 'delta_amount', type: 'numeric', precision: 12, scale: 2 })
  deltaAmount: string;

  /** 冻结当天等级 / 当前等级（评估更正留痕） */
  @Column({ name: 'frozen_grade', type: 'varchar', length: 20, nullable: true })
  frozenGrade: string | null;

  @Column({ name: 'current_grade', type: 'varchar', length: 20, nullable: true })
  currentGrade: string | null;

  /** 冻结日费 / 当前日费（费率补录留痕） */
  @Column({ name: 'frozen_daily_rate', type: 'numeric', precision: 12, scale: 2, nullable: true })
  frozenDailyRate: string | null;

  @Column({ name: 'current_daily_rate', type: 'numeric', precision: 12, scale: 2, nullable: true })
  currentDailyRate: string | null;

  @Column({ name: 'note', type: 'text' })
  note: string;

  @Column({ name: 'status', type: 'varchar', length: 20, default: AdjustmentStatus.OPEN })
  status: AdjustmentStatus;

  /** 建议被哪个后续封账版本纳入 */
  @ManyToOne(() => MonthlyBill, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'resolved_by_bill_id' })
  resolvedByBill: MonthlyBill | null;

  @Column({ name: 'resolved_by_bill_id', type: 'uuid', nullable: true })
  resolvedByBillId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
