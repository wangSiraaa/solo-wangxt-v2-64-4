import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { BillStatus, GradeCode } from '../src/common/enums';
import { BillingService } from '../src/billing/billing.service';
import { FeesService } from '../src/fees/fees.service';

/**
 * 月度账单闭环 e2e：
 *  草稿/试算/封账/重开/替代状态机；闰月月中换级可解释明细；
 *  重复/并发封账仅一个有效版本；封账后费率补录只生调整建议原账不变；
 *  重开重算失败旧封账仍可用且无半套明细；版本链/每日来源/调整关系重启可回放；
 *  未封账的 /fees/segments 查询保持兼容；OpenAPI 文档可获取。
 */
describe('月度账单闭环 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ds: DataSource;
  let billing: BillingService;

  const ELDER = 'E-BILL';
  const MONTH = '2024-02'; // 闰年 29 天

  const ITEMS_8 = [
    'TRANSFER',
    'WALKING',
    'BATHING',
    'DRESSING',
    'TOILETING',
    'EATING',
    'CONTINENCE',
    'GROOMING',
  ];

  function answers(
    override: Record<string, string> = {},
    omit: string[] = [],
  ) {
    const map: Record<string, string> = {};
    for (const code of ITEMS_8) map[code] = 'INDEPENDENT';
    map.STAIRS = 'INDEPENDENT';
    map.OUTDOOR = 'INDEPENDENT';
    Object.assign(map, override);
    return Object.entries(map)
      .filter(([code]) => !omit.includes(code))
      .map(([itemCode, optionCode]) => ({ itemCode, optionCode }));
  }

  function severeAnswers() {
    const o: Record<string, string> = {};
    for (const c of ITEMS_8) o[c] = 'TOTAL_DEP';
    return answers(o);
  }

  async function createCase(
    elderId: string,
    a1: ReturnType<typeof answers>,
    a2: ReturnType<typeof answers>,
    familyContact = '13900000000',
  ) {
    const res = await http
      .post('/api/assessments')
      .send({
        elderId,
        elderName: `老人${elderId}`,
        familyContact,
        assessors: [
          { assessorId: 1, answers: a1 },
          { assessorId: 2, answers: a2 },
        ],
      })
      .expect(201);
    return res.body;
  }

  async function makeLightToSevereFebruary() {
    // 轻度 2024-02-01 起生效
    const light = await createCase(ELDER, answers({}), answers({}));
    expect(light.confirmedGrade).toBe(GradeCode.LIGHT);
    await http
      .post('/api/fees/activate')
      .send({ caseId: light.id, effectiveDate: '2024-02-01' })
      .expect(201);

    // 重度冲突案件 → 管理员复核确认 → 2024-02-15 月中换级
    const severe = await createCase(ELDER, answers({}), severeAnswers());
    expect(severe.status).toBe('PENDING_REVIEW');
    await http
      .post(`/api/assessments/${severe.id}/review/confirm`)
      .send({
        confirmedGrade: GradeCode.SEVERE,
        reviewerId: 'mgr-bill',
        comment: '复核确认重度，二月中换级',
      })
      .expect(201);
    await http
      .post('/api/fees/activate')
      .send({ caseId: severe.id, effectiveDate: '2024-02-15' })
      .expect(201);
    return severe;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.setGlobalPrefix('api');
    await app.init();
    http = request(app.getHttpServer());
    ds = app.get(DataSource);
    billing = app.get(BillingService);
    await ds.query(`
      TRUNCATE bill_daily_lines, bill_adjustment_suggestions, monthly_bill_events,
               monthly_bills, grade_periods, notification_records, review_decisions,
               assessor_answers, assessment_cases RESTART IDENTITY CASCADE
    `);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  it('OpenAPI 文档可获取且包含账单闭环接口', async () => {
    const res = await http.get('/api/openapi.json').expect(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.paths['/billing/bills/trial'].post).toBeTruthy();
    expect(res.body.paths['/billing/bills/{billId}/close'].post).toBeTruthy();
    expect(res.body.paths['/billing/bills/{billId}/reopen'].post).toBeTruthy();
    expect(res.body.paths['/billing/bills/{billId}/diff'].post).toBeTruthy();
    expect(
      res.body.components.schemas.MonthlyBillSummary.properties.status.enum,
    ).toEqual(['DRAFT', 'TRIALED', 'CLOSED', 'REOPENED', 'SUPERSEDED']);
  });

  // -------------------------------------------------------------------------
  it('闰月月中换级：试算封出可解释明细（29 天守恒，1~14 轻度 / 15~29 重度，5900.00）', async () => {
    await makeLightToSevereFebruary();

    // 先送达一条告知，封账后应被冻结进快照
    const cases = await ds.query(
      `SELECT c.id FROM assessment_cases c WHERE c.elder_id=$1 ORDER BY c.created_at LIMIT 1`,
      [ELDER],
    );
    await http
      .post(`/api/assessments/${cases[0].id}/notification/attempt`)
      .send({})
      .expect(201);

    const trial = await http
      .post('/api/billing/bills/trial')
      .send({ elderId: ELDER, billMonth: MONTH, actor: 'finance-a' })
      .expect(201);
    expect(trial.body.replayed).toBe(false);
    const bill = trial.body.bill;
    expect(bill.status).toBe('TRIALED');
    expect(bill.versionNo).toBe(1);
    expect(bill.totalDays).toBe(29);
    expect(bill.lines).toHaveLength(29);
    expect(bill.totalAmount).toBe('5900.00');

    // 逐行可解释：首日/换级日/末日
    const day1 = bill.lines.find((l: any) => l.lineDate === '2024-02-01');
    expect(day1).toMatchObject({
      grade: GradeCode.LIGHT,
      dailyRate: '100.00',
      amount: '100.00',
      source: 'GRADE_PERIOD_AND_RATE',
    });
    expect(day1.gradePeriodId).toBeTruthy();
    expect(day1.rateVersionId).toBeTruthy();
    const change = bill.lines.find((l: any) => l.lineDate === '2024-02-15');
    expect(change).toMatchObject({
      grade: GradeCode.SEVERE,
      dailyRate: '300.00',
      amount: '300.00',
      rateEffectiveFrom: '2024-01-01',
    });
    expect(bill.lines.find((l: any) => l.lineDate === '2024-02-29').amount).toBe(
      '300.00',
    );

    // 合并分段口径与 /fees/segments 一致
    expect(bill.segments).toHaveLength(2);
    expect(bill.segments[0]).toMatchObject({
      startDate: '2024-02-01',
      endDate: '2024-02-14',
      days: 14,
      grade: GradeCode.LIGHT,
      amount: '1400.00',
    });
    expect(bill.segments[1]).toMatchObject({
      startDate: '2024-02-15',
      endDate: '2024-02-29',
      days: 15,
      grade: GradeCode.SEVERE,
      amount: '4500.00',
    });
  });

  it('重复试算幂等刷新同一工作版本（不新增版本/不双明细）；未试算不能封账', async () => {
    const again = await http
      .post('/api/billing/bills/trial')
      .send({ elderId: ELDER, billMonth: MONTH })
      .expect(201);
    expect(again.body.replayed).toBe(true);
    expect(again.body.bill.versionNo).toBe(1);

    const rows = await ds.query(
      `SELECT COUNT(*)::int AS c FROM monthly_bills WHERE elder_id=$1 AND bill_month=$2`,
      [ELDER, MONTH],
    );
    expect(rows[0].c).toBe(1);
    const lineRows = await ds.query(
      `SELECT COUNT(*)::int AS c FROM bill_daily_lines bl
         JOIN monthly_bills b ON b.id=bl.bill_id
        WHERE b.elder_id=$1 AND b.bill_month=$2`,
      [ELDER, MONTH],
    );
    expect(lineRows[0].c).toBe(29);

    // 随机 UUID（不存在）→ 404
    await http
      .post('/api/billing/bills/00000000-0000-0000-0000-000000000000/close')
      .send({})
      .expect(404);
  });

  it('封账冻结四类快照；重复封账回放；并发封账仅一个有效版本', async () => {
    const list = await http
      .get('/api/billing/bills')
      .query({ elderId: ELDER, billMonth: MONTH })
      .expect(200);
    const billId = list.body[0].id;

    const closed = await http
      .post(`/api/billing/bills/${billId}/close`)
      .send({ actor: 'finance-a', comment: '二月账封账' })
      .expect(201);
    expect(closed.body.replayed).toBe(false);
    const bill = closed.body.bill;
    expect(bill.status).toBe('CLOSED');
    expect(bill.frozen).toBe(true);
    expect(bill.totalAmount).toBe('5900.00');
    expect(bill.snapshot).toBeTruthy();
    // 等级期间 ×2、日费版本 ×2（LIGHT@100 / SEVERE@300）、告知 ≥1
    expect(bill.snapshot.gradePeriods).toHaveLength(2);
    expect(bill.snapshot.gradePeriods.map((p: any) => p.grade).sort()).toEqual(
      ['LIGHT', 'SEVERE'],
    );
    expect(bill.snapshot.rateVersions.map((r: any) => r.grade).sort()).toEqual(
      ['LIGHT', 'SEVERE'],
    );
    expect(bill.snapshot.notifications.length).toBeGreaterThanOrEqual(1);
    expect(
      bill.snapshot.notifications.some((n: any) => n.status === 'DELIVERED'),
    ).toBe(true);

    // 事件留痕：TRIALED → CLOSED
    expect(
      bill.events.map((e: any) => e.eventType).filter((t: string) => t === 'TRIALED').length,
    ).toBeGreaterThanOrEqual(1);
    expect(bill.events.some((e: any) => e.eventType === 'CLOSED')).toBe(true);

    // 重复封账 → 幂等回放，不产生新版本
    const rep = await http
      .post(`/api/billing/bills/${billId}/close`)
      .send({})
      .expect(201);
    expect(rep.body.replayed).toBe(true);
    expect(rep.body.bill.status).toBe('CLOSED');
    expect(rep.body.bill.versionNo).toBe(1);

    // 封账后不能再试算起草稿（必须重开）
    const trialAfterClose = await http
      .post('/api/billing/bills/trial')
      .send({ elderId: ELDER, billMonth: MONTH })
      .expect(409);
    expect(JSON.stringify(trialAfterClose.body)).toContain('BILL_ALREADY_CLOSED');

    // 并发封账（针对同一 CLOSED 账单全部回放）
    const concurrent = await Promise.allSettled([
      http.post(`/api/billing/bills/${billId}/close`).send({}),
      http.post(`/api/billing/bills/${billId}/close`).send({}),
      http.post(`/api/billing/bills/${billId}/close`).send({}),
    ]);
    const concurrentResponses = concurrent
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value);
    expect(concurrentResponses).toHaveLength(3);
    expect(concurrentResponses.every((v) => v.status === 201)).toBe(true);

    const dbRows = await ds.query(
      `SELECT status, COUNT(*)::int AS c FROM monthly_bills
        WHERE elder_id=$1 AND bill_month=$2 GROUP BY status`,
      [ELDER, MONTH],
    );
    const closedCount = dbRows.find((r: any) => r.status === 'CLOSED')?.c ?? 0;
    const totalCount = dbRows.reduce((s, r) => s + r.c, 0);
    expect(closedCount).toBe(1); // 仅一个有效封账
    expect(totalCount).toBe(1);
  });

  it('封账后补录费率：只产生跨期调整建议，原账金额/快照/明细不变；未封账费用查询反映新费率（兼容）', async () => {
    const list = await ds.query(
      `SELECT id FROM monthly_bills WHERE elder_id=$1 AND bill_month=$2 AND version_no=1`,
      [ELDER, MONTH],
    );
    const billId = list[0].id;

    // 补录 LIGHT 更早版本：2023-06-01 起 120.00（唯一索引允许不同生效日）
    await ds.query(
      `INSERT INTO fee_rate_versions (grade, effective_from, daily_rate, note)
       VALUES ('LIGHT', '2023-06-01', 120.00, '补录协议价')`,
    );

    const before = await http
      .get(`/api/billing/bills/${billId}`)
      .expect(200);
    expect(before.body.totalAmount).toBe('5900.00');

    const diff = await http
      .post(`/api/billing/bills/${billId}/diff`)
      .send({ actor: 'finance-b' })
      .expect(201);
    expect(diff.body.status).toBe('CLOSED');
    expect(diff.body.frozenAmount).toBe('5900.00'); // 原账不变
    expect(diff.body.currentAmount).toBe('6180.00'); // 当前口径 14*120 + 15*300
    expect(diff.body.deltaAmount).toBe('280.00');
    expect(diff.body.openDeltaAmount).toBe('280.00');
    expect(diff.body.changedDays).toBe(14);
    expect(
      diff.body.suggestions.every((s: any) => s.adjustmentType === 'RATE_CHANGED'),
    ).toBe(true);
    expect(diff.body.suggestions).toHaveLength(14);
    for (const s of diff.body.suggestions) {
      expect(s.lineDate >= '2024-02-01' && s.lineDate <= '2024-02-14').toBe(true);
      expect(s.frozenAmount).toBe('100.00');
      expect(s.currentAmount).toBe('120.00');
      expect(s.deltaAmount).toBe('20.00');
      expect(s.status).toBe('OPEN');
    }

    // 原封账金额、逐日明细、快照均不变
    const after = await http.get(`/api/billing/bills/${billId}`).expect(200);
    expect(after.body.totalAmount).toBe('5900.00');
    expect(
      after.body.lines.find((l: any) => l.lineDate === '2024-02-01').dailyRate,
    ).toBe('100.00');
    expect(after.body.snapshot.rateVersions.find((r: any) => r.grade === 'LIGHT').dailyRate).toBe('100.00');

    // 未封账的原费用查询按当前数据工作，仍返回历史兼容结构
    const seg = await http
      .get('/api/fees/segments')
      .query({ elderId: ELDER, from: '2024-02-01', to: '2024-02-29' })
      .expect(200);
    expect(seg.body.totalAmount).toBe('6180.00');
    expect(seg.body.segments[0].dailyRate).toBe('120.00');
    expect(seg.body.segments[0].amount).toBe('1680.00');
    expect(seg.body.segments).toHaveLength(2);

    // 再次 diff：幂等（仍 14 条 OPEN，不重复挂账）；差异消失后建议自动撤销
    const diff2 = await http
      .post(`/api/billing/bills/${billId}/diff`)
      .send({})
      .expect(201);
    expect(diff2.body.suggestions.filter((s: any) => s.status === 'OPEN')).toHaveLength(14);
  });

  it('重开必须给原因；重算失败时旧封账仍可用、无新版本无半套明细，并留 RECOMPUTE_FAILED 事件', async () => {
    const billId = (
      await ds.query(
        `SELECT id FROM monthly_bills WHERE elder_id=$1 AND bill_month=$2 AND version_no=1`,
        [ELDER, MONTH],
      )
    )[0].id;

    // 缺原因 → 400
    await http
      .post(`/api/billing/bills/${billId}/reopen`)
      .send({})
      .expect(400);

    // 注入一次性重算失败
    const fees = app.get(FeesService);
    const spy = jest
      .spyOn(fees, 'computePricing')
      .mockRejectedValueOnce(new Error('injected recompute outage'));

    const failed = await http
      .post(`/api/billing/bills/${billId}/reopen`)
      .send({ reason: '费率补录后重算（模拟失败）', actor: 'finance-c' })
      .expect(422);
    expect(JSON.stringify(failed.body)).toContain('BILL_RECOMPUTE_FAILED');
    spy.mockRestore();

    const versions = await ds.query(
      `SELECT id, version_no, status FROM monthly_bills
        WHERE elder_id=$1 AND bill_month=$2 ORDER BY version_no`,
      [ELDER, MONTH],
    );
    expect(versions).toHaveLength(1); // 未留下新版本
    expect(versions[0].status).toBe('CLOSED'); // 旧封账仍可用

    const lineCount = await ds.query(
      `SELECT COUNT(*)::int AS c FROM bill_daily_lines WHERE bill_id=$1`,
      [versions[0].id],
    );
    expect(lineCount[0].c).toBe(29); // 旧明细完好，无半套

    const detail = await http
      .get(`/api/billing/bills/${billId}`)
      .expect(200);
    expect(detail.body.status).toBe('CLOSED');
    expect(detail.body.totalAmount).toBe('5900.00');
    const failEvents = detail.body.events.filter(
      (e: any) => e.eventType === 'RECOMPUTE_FAILED',
    );
    expect(failEvents).toHaveLength(1);
    expect(failEvents[0].payload.error).toContain('injected recompute outage');

    // 调整建议依然挂在原账
    expect(
      detail.body.suggestions.filter((s: any) => s.status === 'OPEN'),
    ).toHaveLength(14);
  });

  it('正常重开：从原快照派生 v2(TRIALED)，旧版 REOPENED；并发重开仅一个新版本', async () => {
    const billId = (
      await ds.query(
        `SELECT id FROM monthly_bills WHERE elder_id=$1 AND bill_month=$2 AND version_no=1`,
        [ELDER, MONTH],
      )
    )[0].id;

    const reopen = await http
      .post(`/api/billing/bills/${billId}/reopen`)
      .send({ reason: '补录协议价后跨期更正', actor: 'finance-c' })
      .expect(201);
    expect(reopen.body.predecessor.status).toBe('REOPENED');
    expect(reopen.body.predecessor.versionNo).toBe(1);
    const successor = reopen.body.successor;
    expect(successor.versionNo).toBe(2);
    expect(successor.status).toBe('TRIALED');
    expect(successor.derivedFromBillId).toBe(billId);
    expect(successor.totalAmount).toBe('6180.00'); // 14*120 + 15*300
    expect(successor.lines).toHaveLength(29);
    // v2 明细携带当前（补录后）来源
    expect(successor.lines[0].dailyRate).toBe('120.00');
    expect(successor.lines[0].gradePeriodId).toBeTruthy();
    expect(successor.lines[0].rateVersionId).toBeTruthy();

    // 并发重开同一旧账：一个成功后其余 409（BILL_ALREADY_REOPENED，携带后继 id）
    const races = await Promise.allSettled([
      http
        .post(`/api/billing/bills/${billId}/reopen`)
        .send({ reason: '并发重开 A' }),
      http
        .post(`/api/billing/bills/${billId}/reopen`)
        .send({ reason: '并发重开 B' }),
    ]);
    const raceResponses = races
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value);
    expect(raceResponses).toHaveLength(2);
    for (const res of raceResponses) {
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('BILL_ALREADY_REOPENED');
    }

    // 数据库层：仍只有一个工作版本、总共两个版本
    const rows = await ds.query(
      `SELECT status, COUNT(*)::int AS c FROM monthly_bills
        WHERE elder_id=$1 AND bill_month=$2 GROUP BY status`,
      [ELDER, MONTH],
    );
    const map = Object.fromEntries(rows.map((r) => [r.status, r.c]));
    expect(map.REOPENED).toBe(1);
    expect(map.TRIALED).toBe(1);
    expect(Object.values(map).reduce((s: number, c) => s + (c as number), 0)).toBe(2);
  });

  it('封 v2：v1 变 SUPERSEDED，调整建议随新版本 INCORPORATED；版本链指针闭合', async () => {
    const v2Id = (
      await ds.query(
        `SELECT id FROM monthly_bills WHERE elder_id=$1 AND bill_month=$2 AND version_no=2`,
        [ELDER, MONTH],
      )
    )[0].id;

    const close2 = await http
      .post(`/api/billing/bills/${v2Id}/close`)
      .send({ actor: 'finance-c', comment: '重开后按补录费率封账' })
      .expect(201);
    expect(close2.body.bill.status).toBe('CLOSED');
    expect(close2.body.bill.totalAmount).toBe('6180.00');

    const v1 = await http
      .get(`/api/billing/bills/${close2.body.bill.derivedFromBillId}`)
      .expect(200);
    expect(v1.body.status).toBe('SUPERSEDED');
    expect(v1.body.supersededByBillId).toBe(v2Id);
    expect(v1.body.totalAmount).toBe('5900.00'); // 旧版金额永不改写

    // 旧版 OPEN 建议 → INCORPORATED 且记录 resolvedByBillId
    const suggestions = v1.body.suggestions;
    expect(suggestions.every((s: any) => s.status === 'INCORPORATED')).toBe(true);
    expect(suggestions.every((s: any) => s.resolvedByBillId === v2Id)).toBe(true);
    expect(
      v1.body.events.some((e: any) => e.eventType === 'ADJUSTMENT_INCORPORATED'),
    ).toBe(true);
    expect(
      v1.body.events.some((e: any) => e.eventType === 'SUPERSEDED'),
    ).toBe(true);

    // 已替代账单重开 → 409，指向当前有效封账
    const badReopen = await http
      .post(`/api/billing/bills/${v1.body.id}/reopen`)
      .send({ reason: '尝试重开已替代版本' })
      .expect(409);
    expect(JSON.stringify(badReopen.body)).toContain('BILL_SUPERSEDED');

    // 当前有效封账仍只一个
    const active = await ds.query(
      `SELECT COUNT(*)::int AS c FROM monthly_bills
        WHERE elder_id=$1 AND bill_month=$2 AND status='CLOSED'`,
      [ELDER, MONTH],
    );
    expect(active[0].c).toBe(1);
  });

  it('封账后评估更正（等级期间变化）：生成 GRADE_CHANGED 建议，原账不变', async () => {
    const v2Id = (
      await ds.query(
        `SELECT id FROM monthly_bills WHERE elder_id=$1 AND bill_month=$2 AND version_no=2`,
        [ELDER, MONTH],
      )
    )[0].id;

    // 直接 SQL 模拟评估更正：第一段 LIGHT 期间改为 MODERATE（14 天）
    await ds.query(
      `UPDATE grade_periods SET grade='MODERATE'
        WHERE id=(
          SELECT gp.id FROM grade_periods gp
           WHERE gp.elder_id=$1 AND gp.grade='LIGHT'
           ORDER BY gp.start_date LIMIT 1
        )`,
      [ELDER],
    );

    const diff = await http
      .post(`/api/billing/bills/${v2Id}/diff`)
      .send({})
      .expect(201);
    expect(diff.body.frozenAmount).toBe('6180.00');
    // 14 天 LIGHT@120 → MODERATE@200：每天 +80，共 +1120
    expect(diff.body.deltaAmount).toBe('1120.00');
    expect(diff.body.changedDays).toBe(14);
    expect(
      diff.body.suggestions.filter((s: any) => s.status === 'OPEN'),
    ).toHaveLength(14);
    expect(
      diff.body.suggestions
        .filter((s: any) => s.status === 'OPEN')
        .every((s: any) => s.adjustmentType === 'GRADE_CHANGED'),
    ).toBe(true);
    const first = diff.body.suggestions.find(
      (s: any) => s.lineDate === '2024-02-01',
    );
    expect(first).toMatchObject({
      frozenGrade: 'LIGHT',
      currentGrade: 'MODERATE',
      frozenAmount: '120.00',
      currentAmount: '200.00',
      deltaAmount: '80.00',
    });

    const detail = await http.get(`/api/billing/bills/${v2Id}`).expect(200);
    expect(detail.body.totalAmount).toBe('6180.00'); // 原账不变
    expect(detail.body.lines[0].grade).toBe('LIGHT');
  });

  it('差异消失（数据恢复）：OPEN 建议自动撤销，不挂账已消失差异', async () => {
    const v2Id = (
      await ds.query(
        `SELECT id FROM monthly_bills WHERE elder_id=$1 AND bill_month=$2 AND version_no=2`,
        [ELDER, MONTH],
      )
    )[0].id;
    await ds.query(
      `UPDATE grade_periods SET grade='LIGHT'
        WHERE id=(
          SELECT gp.id FROM grade_periods gp
           WHERE gp.elder_id=$1 AND gp.grade='MODERATE'
           ORDER BY gp.start_date LIMIT 1
        )`,
      [ELDER],
    );
    const diff = await http
      .post(`/api/billing/bills/${v2Id}/diff`)
      .send({})
      .expect(201);
    expect(diff.body.changedDays).toBe(0);
    expect(diff.body.openDeltaAmount).toBe('0.00');
    expect(
      diff.body.suggestions.filter((s: any) => s.status === 'OPEN'),
    ).toHaveLength(0);
  });

  it('并发起算/并发起封：串行化落库，最终仅一个版本且为 CLOSED', async () => {
    const c = await createCase('E-BILL-PAR', answers({}), answers({}));
    await http
      .post('/api/fees/activate')
      .send({ caseId: c.id, effectiveDate: '2024-02-01' })
      .expect(201);

    // 5 个并发起算（服务端咨询锁串行化 + DB 唯一工作版本索引兜底）
    const trialRaces = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        http
          .post('/api/billing/bills/trial')
          .send({ elderId: 'E-BILL-PAR', billMonth: '2024-02' }),
      ),
    );
    const trialFulfilled = trialRaces
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value);
    expect(trialFulfilled).toHaveLength(5);
    expect(trialFulfilled.filter((v) => v.status === 201)).toHaveLength(5);
    expect(trialFulfilled.filter((v) => v.body.replayed === false)).toHaveLength(1);
    expect(trialFulfilled.filter((v) => v.body.replayed === true)).toHaveLength(4);

    const only = await ds.query(
      `SELECT id FROM monthly_bills WHERE elder_id='E-BILL-PAR' AND bill_month='2024-02'`,
    );
    expect(only).toHaveLength(1);

    // 5 个并发起封：仅一个真正封账，其余回放
    const closeRaces = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        http
          .post(`/api/billing/bills/${only[0].id}/close`)
          .send({}),
      ),
    );
    const closeFulfilled = closeRaces
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value);
    expect(closeFulfilled).toHaveLength(5);
    expect(closeFulfilled.filter((v) => v.status === 201)).toHaveLength(5);
    expect(closeFulfilled.filter((v) => v.body.replayed === false)).toHaveLength(1);
    expect(closeFulfilled.filter((v) => v.body.replayed === true)).toHaveLength(4);

    const finalRows = await ds.query(
      `SELECT status, COUNT(*)::int AS c FROM monthly_bills
        WHERE elder_id='E-BILL-PAR' AND bill_month='2024-02' GROUP BY status`,
    );
    expect(finalRows).toEqual([{ status: 'CLOSED', c: 1 }]);
  });

  it('版本链列表与非法月份校验', async () => {
    const versions = await http
      .get('/api/billing/bills')
      .query({ elderId: ELDER })
      .expect(200);
    expect(versions.body).toHaveLength(2);
    expect(versions.body.map((b: any) => b.versionNo)).toEqual([1, 2]);
    expect(versions.body[0].status).toBe('SUPERSEDED');
    expect(versions.body[1].status).toBe('CLOSED');

    await http
      .post('/api/billing/bills/trial')
      .send({ elderId: ELDER, billMonth: '2024-13' })
      .expect(400);
  });

  // -------------------------------------------------------------------------
  it('重启后：账单版本链、每日来源、调整关系均可回放，封账金额不变', async () => {
    // 关闭旧应用，重新启动（嵌入式 PG 作为独立子进程仍在运行）
    await app.close();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.setGlobalPrefix('api');
    await app.init();
    http = request(app.getHttpServer());
    ds = app.get(DataSource);
    billing = app.get(BillingService);

    const rows = await ds.query(
      `SELECT id, version_no, status, total_amount::text AS total_amount
         FROM monthly_bills
        WHERE elder_id=$1 AND bill_month=$2 ORDER BY version_no`,
      [ELDER, MONTH],
    );
    expect(rows).toHaveLength(2);
    const [v1Row, v2Row] = rows;
    expect(v1Row.status).toBe('SUPERSEDED');
    expect(v2Row.status).toBe('CLOSED');
    expect(v1Row.total_amount).toBe('5900.00');
    expect(v2Row.total_amount).toBe('6180.00');

    const v2 = await billing.get(v2Row.id);
    // 逐日明细 29 行且每日来源（等级期间 id + 日费版本 id）可回放
    expect(v2.lines).toHaveLength(29);
    expect(v2.lines.slice(0, 14).every((l) => l.grade === GradeCode.LIGHT)).toBe(true);
    expect(v2.lines.slice(14).every((l) => l.grade === GradeCode.SEVERE)).toBe(true);
    expect(
      v2.lines.every(
        (l) =>
          l.source === 'NO_EFFECTIVE_GRADE' ||
          (!!l.gradePeriodId && !!l.rateVersionId),
      ),
    ).toBe(true);

    // 快照仍可回放：冻结期间/版本/告知
    expect(v2.snapshot?.gradePeriods).toHaveLength(2);
    expect(v2.snapshot?.rateVersions.length).toBeGreaterThanOrEqual(2);
    expect(v2.snapshot?.notifications.length).toBeGreaterThanOrEqual(1);

    // 版本链：v2 → v1 指针双向闭合
    expect(v2.derivedFromBillId).toBe(v1Row.id);
    const v1 = await billing.get(v1Row.id);
    expect(v1.supersededByBillId).toBe(v2Row.id);

    // 调整关系：14 条费率建议全部 INCORPORATED 且指向 v2
    const incorporated = v1.suggestions;
    expect(incorporated).toHaveLength(14);
    expect(incorporated.every((s) => s.status === 'INCORPORATED')).toBe(true);
    expect(incorporated.every((s) => s.resolvedByBillId === v2Row.id)).toBe(true);

    // 事件链完整
    const eventTypes = v2.events.map((e) => e.eventType);
    expect(eventTypes).toContain('TRIALED');
    expect(eventTypes).toContain('CLOSED');
    const v1EventTypes = v1.events.map((e) => e.eventType);
    expect(v1EventTypes).toContain('REOPENED');
    expect(v1EventTypes).toContain('SUPERSEDED');
    expect(v1EventTypes).toContain('ADJUSTMENT_INCORPORATED');

    // 未封账的原费用查询仍可用且结构兼容
    const seg = await http
      .get('/api/fees/segments')
      .query({ elderId: ELDER, from: '2024-02-01', to: '2024-02-29' })
      .expect(200);
    expect(seg.body).toEqual(
      expect.objectContaining({
        elderId: ELDER,
        from: '2024-02-01',
        to: '2024-02-29',
        totalDays: 29,
        totalAmount: '6180.00',
      }),
    );
    expect(seg.body.segments[0]).toHaveProperty('gradePeriodId');
    expect(seg.body.segments[0]).toHaveProperty('rateEffectiveFrom');
  });
});
