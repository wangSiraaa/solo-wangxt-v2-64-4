import { DataSource, DataSourceOptions } from 'typeorm';
import { ScaleVersion } from '../entities/scale-version.entity';
import { ScaleItem } from '../entities/scale-item.entity';
import { ScaleOption } from '../entities/scale-option.entity';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { AssessorAnswer } from '../entities/assessor-answer.entity';
import { ReviewDecision } from '../entities/review-decision.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { FeeRateVersion } from '../entities/fee-rate-version.entity';
import { MonthlyBill } from '../entities/monthly-bill.entity';
import { BillDailyLine } from '../entities/bill-daily-line.entity';
import { BillAdjustmentSuggestion } from '../entities/bill-adjustment-suggestion.entity';
import { MonthlyBillEvent } from '../entities/monthly-bill-event.entity';
import { seedDemoData } from './seed';

export const entities = [
  ScaleVersion,
  ScaleItem,
  ScaleOption,
  AssessmentCase,
  AssessorAnswer,
  ReviewDecision,
  NotificationRecord,
  GradeEffectivePeriod,
  FeeRateVersion,
  MonthlyBill,
  BillDailyLine,
  BillAdjustmentSuggestion,
  MonthlyBillEvent,
];

export function buildDataSourceOptions(): DataSourceOptions {
  return {
    type: 'postgres',
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'eldercare',
    entities,
    synchronize: false,
  };
}

/**
 * 幂等建表 + 约束（首次启动建表；后续启动只补缺）。
 * 同一老人同一天不得出现重叠生效等级：
 *   btree_gist 提供 daterange 排他约束（半开区间，相邻期间首尾相接不算重叠）。
 * 月度账单版本约束：
 *   - 同老人同月份最多一个工作版本（DRAFT/TRIALED）、最多一个有效封账（CLOSED）；
 *   - OPEN 调整建议在 账单×类型×自然日 上唯一；
 *   服务层事务 + 行锁先行，部分唯一索引为并发最终防线。
 */
export async function ensureSchema(dataSource: DataSource): Promise<void> {
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

  const exists = await dataSource.query(
    `SELECT to_regclass('grade_periods') IS NOT NULL AS ok`,
  );
  if (!exists[0].ok) {
    await dataSource.synchronize();
  } else {
    // 旧库升级：账单相关新表由 synchronize 幂等补齐（只建不存在的表）
    const billsExist = await dataSource.query(
      `SELECT to_regclass('monthly_bills') IS NOT NULL AS ok`,
    );
    if (!billsExist[0].ok) {
      await dataSource.synchronize();
    }
  }

  const constraint = await dataSource.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'grade_periods_no_overlap'`,
  );
  if (constraint.length === 0) {
    await dataSource.query(`
      ALTER TABLE grade_periods
        ADD CONSTRAINT grade_periods_no_overlap
        EXCLUDE USING gist (
          elder_id WITH =,
          daterange(start_date, end_date_exclusive, '[)') WITH &&
        )
    `);
  }

  // ---- 月度账单闭环：幂等索引（IF NOT EXISTS 支持重复启动/旧库迁移） ----
  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS monthly_bills_one_working_version
      ON monthly_bills (elder_id, bill_month)
      WHERE status IN ('DRAFT', 'TRIALED')
  `);
  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS monthly_bills_one_active_closed
      ON monthly_bills (elder_id, bill_month)
      WHERE status = 'CLOSED'
  `);
  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS bill_adjustment_suggestions_one_open
      ON bill_adjustment_suggestions (bill_id, adjustment_type, line_date)
      WHERE status = 'OPEN'
  `);

  // 封账合法性：CLOSED 必须带快照；有快照意味着金额已冻结（状态守卫见服务层）
  await dataSource.query(`
    ALTER TABLE monthly_bills DROP CONSTRAINT IF EXISTS monthly_bills_closed_needs_snapshot
  `);
  await dataSource.query(`
    ALTER TABLE monthly_bills
      ADD CONSTRAINT monthly_bills_closed_needs_snapshot
      CHECK (status <> 'CLOSED' OR snapshot IS NOT NULL)
  `);
}

let singleton: Promise<DataSource> | null = null;

/** 一次性“连接-建表-种子”（独立脚本使用） */
export async function buildInitializedDataSource(): Promise<DataSource> {
  const ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();
  await ensureSchema(ds);
  await seedDemoData(ds);
  return ds;
}

/** Nest 启动与 e2e 测试共用同一套“连接-建表-种子”流程 */
export function getOrCreateDataSource(): Promise<DataSource> {
  if (!singleton) {
    singleton = (async () => {
      const ds = new DataSource(buildDataSourceOptions());
      await ds.initialize();
      await ensureSchema(ds);
      await seedDemoData(ds);
      return ds;
    })();
    singleton.catch(() => {
      singleton = null; // 允许后续重试
    });
  }
  return singleton;
}
