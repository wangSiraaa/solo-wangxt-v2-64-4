import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MonthlyBill } from './monthly-bill.entity';

/**
 * 账单逐日明细：账期内每天一行，天数守恒（行数 = 账期自然日数）。
 *
 *  - TRIALED 期间随试算整体重算（同事务内先删后插）；
 *  - CLOSED 后随账单冻结，任何后续数据变化不得改写这些行；
 *  - 每行记录等级期间来源 id 与日费版本来源 id，封账后仍可回放“每日来源”。
 */
@Entity('bill_daily_lines')
@Index(['bill', 'lineDate'], { unique: true })
export class BillDailyLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => MonthlyBill, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bill_id' })
  bill: MonthlyBill;

  @Column({ name: 'bill_id', type: 'uuid' })
  billId: string;

  /** 自然日 YYYY-MM-DD（账期内唯一） */
  @Column({ name: 'line_date', type: 'date' })
  lineDate: string;

  /** 当天等级；无生效等级为 null（空洞） */
  @Column({ name: 'grade', type: 'varchar', length: 20, nullable: true })
  grade: string | null;

  /** 当天适用日费；无等级/无费率规则为 null */
  @Column({ name: 'daily_rate', type: 'numeric', precision: 12, scale: 2, nullable: true })
  dailyRate: string | null;

  /** 当日金额（0.00 表示不计费） */
  @Column({ name: 'amount', type: 'numeric', precision: 12, scale: 2 })
  amount: string;

  /**
   * GRADE_PERIOD_AND_RATE | GRADE_PERIOD_NO_RATE | NO_EFFECTIVE_GRADE
   * 与费用分段接口同源，保证逐行可解释。
   */
  @Column({ name: 'source', type: 'varchar', length: 40 })
  source: string;

  @Column({ name: 'note', type: 'text' })
  note: string;

  /** 等级期间来源（grade_periods.id）；空洞为 null */
  @Column({ name: 'grade_period_id', type: 'uuid', nullable: true })
  gradePeriodId: string | null;

  /** 日费版本来源（fee_rate_versions.id）；未适用为 null */
  @Column({ name: 'rate_version_id', type: 'uuid', nullable: true })
  rateVersionId: string | null;

  /** 日费版本生效首日（冗余留痕，封账后费率版本被改也不影响本行） */
  @Column({ name: 'rate_effective_from', type: 'date', nullable: true })
  rateEffectiveFrom: string | null;
}
