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
 * 月度账单闭环的持久化迁移见 ensureBillingSchema：
 * 显式 DDL 保证新库/旧库结构一致（synchronize 只负责列结构，约束/部分索引在此管理）。
 */
export async function ensureSchema(dataSource: DataSource): Promise<void> {
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

  const exists = await dataSource.query(
    `SELECT to_regclass('grade_periods') IS NOT NULL AS ok`,
  );
  if (!exists[0].ok) {
    await dataSource.synchronize();
  } else {
    // 旧库：补齐月度账单新表的列结构（约束在 ensureBillingSchema 统一处理）
    const billExists = await dataSource.query(
      `SELECT to_regclass('monthly_bills') IS NOT NULL AS ok`,
    );
    if (!billExists[0].ok) {
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

  await ensureBillingSchema(dataSource);
}

/**
 * 月度账单闭环持久化迁移（幂等）：
 *  - 账单状态机 CHECK、重开原因必填 CHECK；
 *  - 版本链 (elder, month, versionNo) 唯一；
 *  - 同一老人月至多一个 SEALED（重复/并发封账的最终防线）；
 *  - 同一老人月至多一个开放版本 DRAFT/TRIALED（并发重开/重复建草稿的最终防线）；
 *  - 逐日明细一版本一天恰好一行；
 *  - 调整建议 OPEN 去重部分唯一索引。
 */
export async function ensureBillingSchema(
  dataSource: DataSource,
): Promise<void> {
  await dataSource
    .query(
      `
    ALTER TABLE monthly_bills
      ADD CONSTRAINT monthly_bills_status_check
      CHECK (status IN ('DRAFT','TRIALED','SEALED','REOPENED','SUPERSEDED'))
  `,
    )
    .catch((e: any) => {
      if (!/already exists/.test(String(e?.message ?? e))) throw e;
    });

  await dataSource
    .query(
      `
    ALTER TABLE monthly_bills
      ADD CONSTRAINT monthly_bills_reopen_reason_check
      CHECK (
        status NOT IN ('REOPENED')
        OR (reopen_reason IS NOT NULL AND btrim(reopen_reason) <> '')
      )
  `,
    )
    .catch((e: any) => {
      if (!/already exists/.test(String(e?.message ?? e))) throw e;
    });

  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS monthly_bills_version_unique
      ON monthly_bills (elder_id, bill_month, version_no)
  `);

  // 同一老人同一月份至多一个“已封账且有效”的版本
  // （重开后旧版本为 REOPENED、被替代为 SUPERSEDED，均退出唯一约束）
  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS monthly_bills_one_sealed
      ON monthly_bills (elder_id, bill_month)
      WHERE status = 'SEALED'
  `);

  // 同一老人同一月份至多一个开放中版本（DRAFT/TRIALED）
  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS monthly_bills_one_open
      ON monthly_bills (elder_id, bill_month)
      WHERE status IN ('DRAFT','TRIALED')
  `);

  // 版本链引用一致（仅做防御性外键，业务上所有迁移在事务内成对完成）
  await dataSource.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'monthly_bills_predecessor_fk'
      ) THEN
        ALTER TABLE monthly_bills
          ADD CONSTRAINT monthly_bills_predecessor_fk
          FOREIGN KEY (predecessor_id) REFERENCES monthly_bills(id);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'monthly_bills_successor_fk'
      ) THEN
        ALTER TABLE monthly_bills
          ADD CONSTRAINT monthly_bills_successor_fk
          FOREIGN KEY (successor_id) REFERENCES monthly_bills(id);
      END IF;
    END $$
  `);

  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS bill_daily_lines_bill_date_unique
      ON bill_daily_lines (bill_id, line_date)
  `);

  await dataSource
    .query(
      `
    ALTER TABLE bill_adjustment_suggestions
      ADD CONSTRAINT bill_adjustment_status_check
      CHECK (status IN ('OPEN','SUPERSEDED'))
  `,
    )
    .catch((e: any) => {
      if (!/already exists/.test(String(e?.message ?? e))) throw e;
    });

  // OPEN 建议的业务去重键（实体上的 @Index 仅声明列，复合部分唯一索引在此显式建立）
  await dataSource.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS bill_adj_open_business_unique
      ON bill_adjustment_suggestions (
        bill_id, change_type, from_date, to_date,
        sealed_amount, current_amount
      )
      WHERE status = 'OPEN'
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
