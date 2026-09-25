import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BillEventType } from '../common/enums';
import { MonthlyBill } from './monthly-bill.entity';

/**
 * 账单生命周期事件（审计留痕）：试算/封账/重开/替代/调整建议/重算失败逐行记录，
 * 重启后可完整回放版本链、每日来源与调整关系。
 */
@Entity('monthly_bill_events')
export class MonthlyBillEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @ManyToOne(() => MonthlyBill, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bill_id' })
  bill: MonthlyBill;

  @Column({ name: 'bill_id', type: 'uuid' })
  billId: string;

  @Column({ name: 'event_type', type: 'varchar', length: 40 })
  eventType: BillEventType;

  /** 操作人（SYSTEM 表示系统自动） */
  @Column({ name: 'actor', type: 'varchar', length: 64, default: 'SYSTEM' })
  actor: string;

  @Column({ name: 'reason', type: 'text', nullable: true })
  reason: string | null;

  @Column({ name: 'payload', type: 'jsonb', nullable: true })
  payload: unknown | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
