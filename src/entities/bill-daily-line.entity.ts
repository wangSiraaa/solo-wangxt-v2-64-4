import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BillLineSource } from '../common/enums';
import { MonthlyBill } from './monthly-bill.entity';

/**
 * 账单逐日明细：账单版本内“月内每天一行”，构成可解释的封账快照。
 *  - 试算成功后整体写入/替换（先在内存完成计算，事务内整删整插，
 *    任何失败回滚，绝不留下半套明细）；
 *  - 封账后冻结，任何后续等级/费率变化都不得改写这些行；
 *  - 重开派生新版本时从旧版本行复制为新行，保持新 DRAFT 有完整基线。
 *
 * (bill_id, line_date) 唯一：一个版本一天恰好一行。
 */
@Entity('bill_daily_lines')
@Index(['bill', 'lineDate'], { unique: true })
export class BillDailyLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => MonthlyBill, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bill_id' })
  bill: MonthlyBill;

  @Column({ name: 'line_date', type: 'date' })
  lineDate: string;

  @Column({ name: 'grade', type: 'varchar', length: 20, nullable: true })
  grade: string | null;

  @Column({
    name: 'daily_rate',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
  })
  dailyRate: string | null;

  @Column({ name: 'amount', type: 'numeric', precision: 12, scale: 2 })
  amount: string;

  @Column({ name: 'source', type: 'varchar', length: 32 })
  source: BillLineSource;

  @Column({ name: 'grade_period_id', type: 'uuid', nullable: true })
  gradePeriodId: string | null;

  @Column({ name: 'rate_version_id', type: 'uuid', nullable: true })
  rateVersionId: string | null;

  @Column({ name: 'rate_effective_from', type: 'date', nullable: true })
  rateEffectiveFrom: string | null;

  @Column({ name: 'note', type: 'text' })
  note: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
