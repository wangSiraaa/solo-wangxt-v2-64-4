import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GradeCode } from '../src/common/enums';

/**
 * 月度账单闭环 e2e（持久化迁移、状态/版本约束、试算/封账/重开/差异 API）：
 *  - 闰月内月中换级封出可解释明细；
 *  - 同一月份重复/并发封账仅一个版本有效；
 *  - 封账后补录费率/评估更正只产生调整建议，原账不变；
 *  - 重开重算失败旧封账仍可用、无半套明细；
 *  - 重启口径下版本链、每日来源、调整关系可回放；
 *  - 未封账的原费用查询保持兼容。
 */
describe('月度账单闭环 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ds: DataSource;

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
  const OPT = {
    INDEPENDENT: 'INDEPENDENT',
    SOME_HELP: 'SOME_HELP',
    MUCH_HELP: 'MUCH_HELP',
    TOTAL_DEP: 'TOTAL_DEP',
  };

  /** 全独立 → LIGHT；全依赖 → SEVERE；MUCH_HELP → MODERATE */
  function answers(mode: 'LIGHT' | 'MODERATE' | 'SEVERE') {
    const opt =
      mode === 'LIGHT'
        ? OPT.INDEPENDENT
        : mode === 'MODERATE'
          ? OPT.MUCH_HELP
          : OPT.TOTAL_DEP;
    const map: Record<string, string> = {};
    for (const code of ITEMS_8) map[code] = opt;
    map.STAIRS = opt;
    map.OUTDOOR = opt;
    return Object.entries(map).map(([itemCode, optionCode]) => ({
      itemCode,
      optionCode,
    }));
  }

  /** 建一个已确认等级的评估案件（一致 → 系统确认） */
  async function confirmedCase(
    elderId: string,
    mode: 'LIGHT' | 'MODERATE' | 'SEVERE',
    contact = '13900000000',
  ): Promise<string> {
    const res = await http
      .post('/api/assessments')
      .send({
        elderId,
        elderName: `老人${elderId}`,
        familyContact: contact,
        assessors: [
          { assessorId: 1, answers: answers(mode) },
          { assessorId: 2, answers: answers(mode) },
        ],
      })
      .expect(201);
    expect(res.body.confirmedGrade).toBe(
      mode === 'LIGHT'
        ? GradeCode.LIGHT
        : mode === 'MODERATE'
          ? GradeCode.MODERATE
          : GradeCode.SEVERE,
    );
    return res.body.id;
  }

  async function activate(caseId: string, date: string) {
    return http
      .post('/api/fees/activate')
      .send({ caseId, effectiveDate: date })
      .expect(201);
  }

  /** 草稿 → 试算 → 封账 的便捷流程，返回各阶段 id */
  async function draftTrialSeal(
    elderId: string,
    month: string,
    sealedBy = 'fin1',
  ) {
    const created = await http
      .post('/api/bills')
      .send({ elderId, billMonth: month })
      .expect(201);
    expect(created.body.bill.status).toBe('DRAFT');
    const id = created.body.bill.id;
    const trial = await http
      .post(`/api/bills/${id}/trial`)
      .send({})
      .expect(201);
    expect(trial.body.bill.status).toBe('TRIALED');
    const sealed = await http
      .post(`/api/bills/${id}/seal`)
      .send({ sealedBy })
      .expect(201);
    expect(sealed.body.bill.status).toBe('SEALED');
    return { id, trial, sealed };
  }

  async function bootstrapApp(): Promise<{
    app: INestApplication;
    http: ReturnType<typeof request>;
    ds: DataSource;
  }> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const application = moduleRef.createNestApplication();
    application.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    application.setGlobalPrefix('api');
    await application.init();
    return {
      app: application,
      http: request(application.getHttpServer()),
      ds: application.get(DataSource),
    };
  }

  beforeAll(async () => {
    const booted = await bootstrapApp();
    app = booted.app;
    http = booted.http;
    ds = booted.ds;
    // 清空账单闭环与费用业务表（保留量表与基础日费种子）
    await ds.query(`
      TRUNCATE bill_adjustment_suggestions, bill_daily_lines, monthly_bills,
               grade_periods, notification_records, review_decisions,
               assessor_answers, assessment_cases RESTART IDENTITY CASCADE
    `);
  }, 120_000);

  afterAll(async () => {
    // 清理本套件写入的补录/调整性日费版本，避免污染其他套件
    if (ds?.isInitialized) {
      await ds
        .query(
          `DELETE FROM fee_rate_versions WHERE note LIKE 'e2e-bill-test:%'`,
        )
        .catch(() => undefined);
    }
    await app.close();
  });

  // ---------------------------------------------------------------------------
  it('闰月月中换级：未试算不能封账；封出 29 天可解释明细并冻结期间/日费/告知快照', async () => {
    // 2024-02 闰年：1~14 LIGHT，15~29 SEVERE（100×14 + 300×15 = 5900）
    const lightCase = await confirmedCase('E-BILL-FEB', 'LIGHT');
    await activate(lightCase, '2024-02-01');
    const severeCase = await confirmedCase('E-BILL-FEB', 'SEVERE');
    await activate(severeCase, '2024-02-15');

    // 建草稿
    const draft = await http
      .post('/api/bills')
      .send({ elderId: 'E-BILL-FEB', billMonth: '2024-02' })
      .expect(201);
    expect(draft.body.replayed).toBe(false);
    const billId = draft.body.bill.id;

    // 重复创建 → 幂等回放同一个草稿，不产生第二条
    const again = await http
      .post('/api/bills')
      .send({ elderId: 'E-BILL-FEB', billMonth: '2024-02' })
      .expect(201);
    expect(again.body.replayed).toBe(true);
    expect(again.body.bill.id).toBe(billId);

    // 未试算直接封账 → 409 BILL_NOT_TRIALED
    const sealEarly = await http
      .post(`/api/bills/${billId}/seal`)
      .send({})
      .expect(409);
    expect(JSON.stringify(sealEarly.body)).toContain('BILL_NOT_TRIALED');

    const trial = await http
      .post(`/api/bills/${billId}/trial`)
      .send({})
      .expect(201);
    expect(trial.body.bill.totalDays).toBe(29);
    expect(trial.body.bill.totalAmount).toBe('5900.00');
    expect(trial.body.daily).toHaveLength(29);

    const sealed = await http
      .post(`/api/bills/${billId}/seal`)
      .send({ sealedBy: 'fin1' })
      .expect(201);
    expect(sealed.body.bill.status).toBe('SEALED');
    expect(sealed.body.bill.inForce).toBe(true);
    expect(sealed.body.bill.hasSnapshot).toBe(true);

    // 快照：期间（含被换级截断的旧期间）、日费、告知均冻结
    const snap = sealed.body.snapshotSummary;
    expect(snap.monthFrom).toBe('2024-02-01');
    expect(snap.monthTo).toBe('2024-02-29');
    expect(snap.periodsCount).toBeGreaterThanOrEqual(2);
    expect(snap.ratesCount).toBeGreaterThanOrEqual(5);
    expect(snap.notificationsCount).toBe(2); // 两个案件各一条 CONFIRMED 告知
    expect(
      snap.notifications.every((n: any) => n.notifiableStatus === 'CONFIRMED'),
    ).toBe(true);

    // 逐日明细可解释：边界两天的每日来源
    const lines = await http.get(`/api/bills/${billId}/lines`).expect(200);
    expect(lines.body.daily).toHaveLength(29);
    const d14 = lines.body.daily[13];
    const d15 = lines.body.daily[14];
    const d29 = lines.body.daily[28];
    expect(d14).toMatchObject({
      date: '2024-02-14',
      grade: 'LIGHT',
      dailyRate: '100.00',
      amount: '100.00',
      source: 'GRADE_PERIOD_AND_RATE',
    });
    expect(d15).toMatchObject({
      date: '2024-02-15',
      grade: 'SEVERE',
      dailyRate: '300.00',
      amount: '300.00',
      source: 'GRADE_PERIOD_AND_RATE',
    });
    expect(d29.date).toBe('2024-02-29'); // 闰月最后一天
    expect(d14.gradePeriodId).not.toBe(d15.gradePeriodId); // 每日等级期间来源不同
    expect(d15.rateVersionId).toBeTruthy();
    expect(d15.rateEffectiveFrom).toBe('2024-01-01');
    expect(lines.body.totalAmount).toBe('5900.00');
  });

  // ---------------------------------------------------------------------------
  it('重复封账：已封账版本再次封账 409，版本链仍只有一个 SEALED', async () => {
    const chainBefore = await http
      .get('/api/bills/chain/E-BILL-FEB/2024-02')
      .expect(200);
    const sealedId = chainBefore.body.inForceBillId;
    expect(sealedId).toBeTruthy();

    const dup = await http
      .post(`/api/bills/${sealedId}/seal`)
      .send({})
      .expect(409);
    expect(JSON.stringify(dup.body)).toContain('BILL_ALREADY_SEALED');

    // 已封账月份再建草稿 → 409
    const createAgain = await http
      .post('/api/bills')
      .send({ elderId: 'E-BILL-FEB', billMonth: '2024-02' })
      .expect(409);
    expect(JSON.stringify(createAgain.body)).toContain('MONTH_ALREADY_SEALED');

    const chainAfter = await http
      .get('/api/bills/chain/E-BILL-FEB/2024-02')
      .expect(200);
    expect(chainAfter.body.versions).toHaveLength(1);
    expect(
      chainAfter.body.versions.filter((v: any) => v.status === 'SEALED'),
    ).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  it('并发封账：同一试算版本的两个并发封账请求仅一个成功，无双有效账单', async () => {
    const c1 = await confirmedCase('E-BILL-CONC-SEAL', 'LIGHT');
    await activate(c1, '2024-02-01');
    const draft = await http
      .post('/api/bills')
      .send({ elderId: 'E-BILL-CONC-SEAL', billMonth: '2024-02' })
      .expect(201);
    const id = draft.body.bill.id;
    await http.post(`/api/bills/${id}/trial`).send({}).expect(201);

    const [a, b] = await Promise.all([
      http.post(`/api/bills/${id}/seal`).send({ sealedBy: 'u1' }),
      http.post(`/api/bills/${id}/seal`).send({ sealedBy: 'u2' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(JSON.stringify([a.body, b.body])).toContain('BILL_ALREADY_SEALED');

    const sealedCount = await ds.query(
      `SELECT count(*)::int AS c FROM monthly_bills
        WHERE elder_id = 'E-BILL-CONC-SEAL' AND bill_month = '2024-02'
          AND status = 'SEALED'`,
    );
    expect(sealedCount[0].c).toBe(1);
  });

  // ---------------------------------------------------------------------------
  it('封账后补录费率：原账金额与明细不变，差异查询仅产生 RATE_BACKFILL 调整建议', async () => {
    const chain = await http
      .get('/api/bills/chain/E-BILL-FEB/2024-02')
      .expect(200);
    const sealedId = chain.body.inForceBillId;

    // 封账后“补录”：SEVERE 日费自 2024-01-15 起 300 → 320（影响 2/15~2/29 共 15 天）
    await ds.query(
      `INSERT INTO fee_rate_versions (id, grade, effective_from, daily_rate, note)
       VALUES (gen_random_uuid(), 'SEVERE', '2024-01-15', '320.00', 'e2e-bill-test: 封账后费率补录 320')`,
    );

    // 原账不动
    const detail = await http.get(`/api/bills/${sealedId}`).expect(200);
    expect(detail.body.bill.totalAmount).toBe('5900.00');
    const still300 = detail.body.daily
      .filter((l: any) => l.date >= '2024-02-15')
      .every((l: any) => l.dailyRate === '300.00');
    expect(still300).toBe(true);

    // 差异：15 天 × 20 = 300
    const diff = await http.get(`/api/bills/${sealedId}/diff`).expect(200);
    expect(diff.body.sealedTotalAmount).toBe('5900.00');
    expect(diff.body.currentTotalAmount).toBe('6200.00');
    expect(diff.body.deltaAmount).toBe('300.00');
    expect(diff.body.suggestions).toHaveLength(1);
    const sug = diff.body.suggestions[0];
    expect(sug.changeType).toBe('RATE_BACKFILL');
    expect(sug.fromDate).toBe('2024-02-15');
    expect(sug.toDate).toBe('2024-02-29');
    expect(sug.days).toBe(15);
    expect(sug.sealedAmount).toBe('4500.00');
    expect(sug.currentAmount).toBe('4800.00');
    expect(sug.deltaAmount).toBe('300.00');
    expect(sug.status).toBe('OPEN');
    expect(sug.reason).toContain('费率补录');
    expect(
      diff.body.daily.every((d: any) => d.changeType === 'RATE_BACKFILL'),
    ).toBe(true);

    // 调整建议可独立查询
    const open = await http
      .get('/api/bills/adjustments')
      .query({ status: 'OPEN' })
      .expect(200);
    expect(open.body.find((s: any) => s.id === sug.id)).toBeTruthy();

    // 幂等：再次差异查询不产生重复 OPEN 建议
    const diff2 = await http.get(`/api/bills/${sealedId}/diff`).expect(200);
    expect(diff2.body.suggestions).toHaveLength(1);
    expect(diff2.body.suggestions[0].id).toBe(sug.id);
  });

  // ---------------------------------------------------------------------------
  it('封账后评估更正（等级期间变化）：产生 GRADE_PERIOD_CHANGE 建议，原账不变', async () => {
    // 另一位老人：整月 LIGHT @100 → 2900
    const c = await confirmedCase('E-BILL-GRADE', 'LIGHT');
    await activate(c, '2024-02-01');
    const { id } = await draftTrialSeal('E-BILL-GRADE', '2024-02');

    // 封账后评估更正：2/11 起改为 MODERATE @200（2/11~2/29 共 19 天，+1900）
    await ds.query(
      `UPDATE grade_periods SET end_date_exclusive = '2024-02-11'
        WHERE elder_id = 'E-BILL-GRADE' AND start_date = '2024-02-01'`,
    );
    const modCase = await confirmedCase('E-BILL-GRADE', 'MODERATE');
    await activate(modCase, '2024-02-11');

    const detail = await http.get(`/api/bills/${id}`).expect(200);
    expect(detail.body.bill.totalAmount).toBe('2900.00');
    expect(detail.body.daily.every((l: any) => l.grade === 'LIGHT')).toBe(true);

    const diff = await http.get(`/api/bills/${id}/diff`).expect(200);
    expect(diff.body.deltaAmount).toBe('1900.00');
    expect(diff.body.suggestions).toHaveLength(1);
    const sug = diff.body.suggestions[0];
    expect(sug.changeType).toBe('GRADE_PERIOD_CHANGE');
    expect(sug.fromDate).toBe('2024-02-11');
    expect(sug.toDate).toBe('2024-02-29');
    expect(sug.days).toBe(19);
    expect(sug.deltaAmount).toBe('1900.00');
    expect(sug.reason).toContain('评估更正');
  });

  // ---------------------------------------------------------------------------
  it('重开必须给原因；并发重开仅一个新版本，重复重开 409', async () => {
    const c = await confirmedCase('E-BILL-REOPEN', 'LIGHT');
    await activate(c, '2024-02-01');
    const { id } = await draftTrialSeal('E-BILL-REOPEN', '2024-02');

    // 缺原因 → 400（DTO 校验）
    await http.post(`/api/bills/${id}/reopen`).send({}).expect(400);
    // 空原因 → 400
    await http
      .post(`/api/bills/${id}/reopen`)
      .send({ reason: '   ' })
      .expect(400);

    // 并发重开：只有一个成功
    const body = { reason: '评估结果更正，需按新等级重算', reopenedBy: 'mgr1' };
    const [a, b] = await Promise.all([
      http.post(`/api/bills/${id}/reopen`).send(body),
      http.post(`/api/bills/${id}/reopen`).send(body),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(JSON.stringify([a.body, b.body])).toContain('BILL_ALREADY_REOPENED');

    const rows = await ds.query(
      `SELECT status, count(*)::int AS c FROM monthly_bills
        WHERE elder_id = 'E-BILL-REOPEN' AND bill_month = '2024-02'
        GROUP BY status ORDER BY status`,
    );
    const counts = Object.fromEntries(rows.map((r: any) => [r.status, r.c]));
    expect(counts.REOPENED).toBe(1);
    expect(counts.DRAFT).toBe(1);
    expect(counts.SEALED).toBeUndefined();

    // 旧版本仍冻结可查；新版本草稿从旧快照派生了完整基线明细
    const predecessor = await http.get(`/api/bills/${id}`).expect(200);
    expect(predecessor.body.bill.status).toBe('REOPENED');
    expect(predecessor.body.bill.totalAmount).toBe('2900.00');
    expect(predecessor.body.daily).toHaveLength(29);

    const chain = await http
      .get('/api/bills/chain/E-BILL-REOPEN/2024-02')
      .expect(200);
    const draftV2 = chain.body.versions.find((v: any) => v.versionNo === 2);
    expect(draftV2.predecessorId).toBe(id);
    expect(chain.body.versions[0].successorId).toBe(draftV2.id);
    const v2lines = await http
      .get(`/api/bills/${draftV2.id}/lines`)
      .expect(200);
    expect(v2lines.body.daily).toHaveLength(29); // 从原快照派生，非半套
  });

  // ---------------------------------------------------------------------------
  it('重开后重算失败：新版本试算 409 且无半套明细，旧封账数据仍可用', async () => {
    // E-BILL-FEB 目前 v1 SEALED；重开它
    const chain0 = await http
      .get('/api/bills/chain/E-BILL-FEB/2024-02')
      .expect(200);
    const v1id = chain0.body.inForceBillId;
    const reopen = await http
      .post(`/api/bills/${v1id}/reopen`)
      .send({
        reason: '封账后补录重度日费，需重算二月账单',
        reopenedBy: 'fin2',
      })
      .expect(201);
    expect(reopen.body.predecessor.status).toBe('REOPENED');
    const v2id = reopen.body.bill.id;
    expect(reopen.body.bill.versionNo).toBe(2);

    // 故障注入：重算失败 → 409 BILL_RECOMPUTE_FAILED
    const fail = await http
      .post(`/api/bills/${v2id}/trial`)
      .send({ simulateRecomputeFailure: true })
      .expect(409);
    expect(JSON.stringify(fail.body)).toContain('BILL_RECOMPUTE_FAILED');

    // 新版本仍是 DRAFT，保留从快照派生的完整 29 行基线，金额仍为旧封账 5900
    const v2 = await http.get(`/api/bills/${v2id}`).expect(200);
    expect(v2.body.bill.status).toBe('DRAFT');
    expect(v2.body.bill.totalAmount).toBe('5900.00');
    expect(v2.body.bill.lastRecomputeError).toContain('RECOMPUTE_FAILED');
    expect(v2.body.daily).toHaveLength(29);
    const baselineOk = v2.body.daily.every(
      (l: any) =>
        (l.date <= '2024-02-14' && l.dailyRate === '100.00') ||
        (l.date >= '2024-02-15' && l.dailyRate === '300.00'),
    );
    expect(baselineOk).toBe(true);

    // 旧封账仍可查可用（REOPENED 冻结数据）
    const old = await http.get(`/api/bills/${v1id}`).expect(200);
    expect(old.body.bill.status).toBe('REOPENED');
    expect(old.body.bill.totalAmount).toBe('5900.00');
    expect(old.body.daily).toHaveLength(29);
    expect(old.body.snapshotSummary.fingerprint).toBeTruthy();

    // 旧封账上的调整建议仍可回放（补录费率产生的 OPEN 建议）
    const oldDiff = await http.get(`/api/bills/${v1id}/diff`).expect(200);
    expect(oldDiff.body.deltaAmount).toBe('300.00');
  });

  // ---------------------------------------------------------------------------
  it('新版本重新试算并封账成功：旧版本 SUPERSEDED，旧建议关闭，新版本为唯一有效', async () => {
    const chain = await http
      .get('/api/bills/chain/E-BILL-FEB/2024-02')
      .expect(200);
    const v2 = chain.body.versions.find((v: any) => v.versionNo === 2);

    const trial = await http
      .post(`/api/bills/${v2.id}/trial`)
      .send({})
      .expect(201);
    // 补录生效：14×100 + 15×320 = 6200
    expect(trial.body.bill.totalAmount).toBe('6200.00');
    expect(
      trial.body.daily.filter((d: any) => d.date === '2024-02-29')[0].dailyRate,
    ).toBe('320.00');

    const sealed = await http
      .post(`/api/bills/${v2.id}/seal`)
      .send({ sealedBy: 'fin2' })
      .expect(201);
    expect(sealed.body.bill.status).toBe('SEALED');
    expect(sealed.body.bill.inForce).toBe(true);
    expect(sealed.body.bill.totalAmount).toBe('6200.00');

    // 旧版本已替代，金额冻结不变；建议被吸收关闭
    const old = await http.get(`/api/bills/${v2.predecessorId}`).expect(200);
    expect(old.body.bill.status).toBe('SUPERSEDED');
    expect(old.body.bill.successorId).toBe(v2.id);
    expect(old.body.bill.totalAmount).toBe('5900.00');
    expect(old.body.daily).toHaveLength(29);

    const chain2 = await http
      .get('/api/bills/chain/E-BILL-FEB/2024-02')
      .expect(200);
    expect(chain2.body.inForceBillId).toBe(v2.id);
    expect(chain2.body.versions).toHaveLength(2);

    const openAdj = await http
      .get('/api/bills/adjustments')
      .query({ billId: v2.predecessorId, status: 'OPEN' })
      .expect(200);
    expect(openAdj.body).toHaveLength(0);
    const closed = await http
      .get('/api/bills/adjustments')
      .query({ billId: v2.predecessorId, status: 'SUPERSEDED' })
      .expect(200);
    expect(closed.body[0].supersededByBillId).toBe(v2.id);

    // 新版本按当前数据无差异（建议为空）
    const newDiff = await http.get(`/api/bills/${v2.id}/diff`).expect(200);
    expect(newDiff.body.deltaAmount).toBe('0.00');
    expect(newDiff.body.suggestions).toHaveLength(0);

    // 已替代旧版本差异查询只读：返回留痕建议（已吸收），不再增删、不 500
    const oldDiff = await http
      .get(`/api/bills/${v2.predecessorId}/diff`)
      .expect(200);
    expect(oldDiff.body.absorbed).toBe(true);
    expect(oldDiff.body.suggestions).toHaveLength(1);
    expect(oldDiff.body.suggestions[0]).toMatchObject({
      status: 'SUPERSEDED',
      supersededByBillId: v2.id,
    });

    // 已替代版本不可再重开
    const reopenSuperseded = await http
      .post(`/api/bills/${v2.predecessorId}/reopen`)
      .send({ reason: '试图重开已替代版本' })
      .expect(409);
    expect(JSON.stringify(reopenSuperseded.body)).toContain('BILL_SUPERSEDED');
  });

  // ---------------------------------------------------------------------------
  it('试算后来源变化不得静默封账：指纹不一致拒绝，重新试算后方可封账', async () => {
    const c = await confirmedCase('E-BILL-CHG', 'LIGHT');
    await activate(c, '2024-02-01');
    const draft = await http
      .post('/api/bills')
      .send({ elderId: 'E-BILL-CHG', billMonth: '2024-02' })
      .expect(201);
    const id = draft.body.bill.id;
    await http.post(`/api/bills/${id}/trial`).send({}).expect(201);

    // 试算后补录 LIGHT 日费（100 → 110，自 2024-02-15 起；避免影响本套件更早的二月封账断言）
    await ds.query(
      `INSERT INTO fee_rate_versions (id, grade, effective_from, daily_rate, note)
       VALUES (gen_random_uuid(), 'LIGHT', '2024-02-15', '110.00', 'e2e-bill-test: 试算后调价 110')`,
    );

    const sealStale = await http
      .post(`/api/bills/${id}/seal`)
      .send({})
      .expect(409);
    expect(JSON.stringify(sealStale.body)).toContain(
      'BILL_SOURCE_CHANGED_AFTER_TRIAL',
    );

    // 重新试算：14 天 ×100（2/1~2/14）+ 15 天 ×110（2/15~2/29）= 3050
    const retrial = await http
      .post(`/api/bills/${id}/trial`)
      .send({})
      .expect(201);
    expect(retrial.body.bill.totalAmount).toBe('3050.00');
    await http.post(`/api/bills/${id}/seal`).send({}).expect(201);
  });

  // ---------------------------------------------------------------------------
  it('无等级空洞日期账单金额为 0 且逐日连续（天数守恒）', async () => {
    // 仅 2/20 起 LIGHT：1~19 为 NO_EFFECTIVE_GRADE
    const c = await confirmedCase('E-BILL-GAP', 'LIGHT');
    await activate(c, '2024-02-20');
    const { id, trial } = await draftTrialSeal('E-BILL-GAP', '2024-02');
    expect(trial.body.daily).toHaveLength(29);
    const gap = trial.body.daily.filter(
      (d: any) => d.source === 'NO_EFFECTIVE_GRADE',
    );
    expect(gap).toHaveLength(19);
    expect(gap[0].date).toBe('2024-02-01');
    expect(gap[18].date).toBe('2024-02-19');
    expect(trial.body.bill.totalAmount).toBe('1100.00'); // 10 天 ×110（补录后 LIGHT 110）

    const lines = await http.get(`/api/bills/${id}/lines`).expect(200);
    expect(lines.body.daily).toHaveLength(29);
  });

  // ---------------------------------------------------------------------------
  it('未封账的原费用查询保持兼容：/fees/segments 仍为实时结果', async () => {
    // E-BILL-FEB 已封账（且已替代到 v2），实时费用反映补录后的 6200
    const sealedMonth = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-BILL-FEB', from: '2024-02-01', to: '2024-02-29' })
      .expect(200);
    expect(sealedMonth.body).toMatchObject({
      elderId: 'E-BILL-FEB',
      from: '2024-02-01',
      to: '2024-02-29',
      totalDays: 29,
      totalAmount: '6200.00',
    });
    expect(sealedMonth.body.segments).toHaveLength(2);
    expect(sealedMonth.body.segments[1]).toMatchObject({
      grade: 'SEVERE',
      dailyRate: '320.00',
      days: 15,
      amount: '4800.00',
    });

    // 从未建账单的老人，费用查询照常工作（结构不变）
    const freshCase = await confirmedCase('E-BILL-NEVER', 'LIGHT');
    await activate(freshCase, '2024-03-01');
    const fresh = await http
      .get('/api/fees/segments')
      .query({ elderId: 'E-BILL-NEVER', from: '2024-03-01', to: '2024-03-10' })
      .expect(200);
    expect(fresh.body.totalDays).toBe(10);
    expect(fresh.body.totalAmount).toBe('1100.00');
    expect(Array.isArray(fresh.body.segments)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  it('重启回放：关闭并重启应用后，版本链、每日来源、快照与调整关系完整可回放', async () => {
    // 取已形成 v1 SUPERSEDED(5900) → v2 SEALED(6200) 的 E-BILL-FEB
    const before = await http
      .get('/api/bills/chain/E-BILL-FEB/2024-02')
      .expect(200);
    const v1 = before.body.versions.find((x: any) => x.versionNo === 1);
    const v2 = before.body.versions.find((x: any) => x.versionNo === 2);
    expect(v1.status).toBe('SUPERSEDED');
    expect(v2.status).toBe('SEALED');
    expect(before.body.inForceBillId).toBe(v2.id);

    // 重启应用（嵌入式 PostgreSQL 子进程持续运行，数据已持久化）
    await app.close();
    const rebooted = await bootstrapApp();
    app = rebooted.app;
    http = rebooted.http;
    ds = rebooted.ds;

    // 1) 版本链：派生关系与唯一有效版本不变
    const chain = await http
      .get('/api/bills/chain/E-BILL-FEB/2024-02')
      .expect(200);
    expect(chain.body.versions).toHaveLength(2);
    const rv1 = chain.body.versions.find((x: any) => x.versionNo === 1);
    const rv2 = chain.body.versions.find((x: any) => x.versionNo === 2);
    expect(rv1.status).toBe('SUPERSEDED');
    expect(rv2.status).toBe('SEALED');
    expect(chain.body.inForceBillId).toBe(rv2.id);
    expect(rv2.predecessorId).toBe(rv1.id);
    expect(rv1.successorId).toBe(rv2.id);
    expect(rv1.reopenReason).toContain('补录重度日费');

    // 2) 每日来源：两版本逐日明细均 29 行，金额冻结口径不变
    const l1 = await http.get(`/api/bills/${rv1.id}/lines`).expect(200);
    const l2 = await http.get(`/api/bills/${rv2.id}/lines`).expect(200);
    expect(l1.body.daily).toHaveLength(29);
    expect(l2.body.daily).toHaveLength(29);
    expect(l1.body.totalAmount).toBe('5900.00');
    expect(l2.body.totalAmount).toBe('6200.00');
    // v1 冻结为 300；v2 重算为 320，各自每日费率版本来源可回放
    expect(l1.body.daily[28]).toMatchObject({
      date: '2024-02-29',
      grade: 'SEVERE',
      dailyRate: '300.00',
    });
    expect(l2.body.daily[28]).toMatchObject({
      date: '2024-02-29',
      grade: 'SEVERE',
      dailyRate: '320.00',
    });
    expect(l2.body.daily[28].gradePeriodId).toBeTruthy();
    expect(l2.body.daily[28].rateVersionId).toBeTruthy();

    // 3) 封账快照可回放：冻结期间、日费、告知仍在
    const d2 = await http.get(`/api/bills/${rv2.id}`).expect(200);
    expect(d2.body.snapshotSummary).toBeTruthy();
    expect(d2.body.snapshotSummary.monthFrom).toBe('2024-02-01');
    expect(d2.body.snapshotSummary.monthTo).toBe('2024-02-29');
    expect(d2.body.snapshotSummary.notificationsCount).toBe(2);
    // v1 快照冻结的日费里不含 320 补录版本的记录（以其冻结的 rates 重算仍为 300）
    const d1 = await http.get(`/api/bills/${rv1.id}`).expect(200);
    const v1Rates = d1.body.snapshotSummary.rates.map((r: any) => r.dailyRate);
    expect(v1Rates).not.toContain('320.00');

    // 4) 调整关系：v1 上的补录建议已被 v2 封账吸收（SUPERSEDED 且指向 v2）
    const closed = await http
      .get('/api/bills/adjustments')
      .query({ billId: rv1.id, status: 'SUPERSEDED' })
      .expect(200);
    expect(closed.body).toHaveLength(1);
    expect(closed.body[0]).toMatchObject({
      changeType: 'RATE_BACKFILL',
      deltaAmount: '300.00',
      supersededByBillId: rv2.id,
    });

    // 5) 重启后再跑差异查询，当前有效版本 v2 无差异
    const diff = await http.get(`/api/bills/${rv2.id}/diff`).expect(200);
    expect(diff.body.deltaAmount).toBe('0.00');
    expect(diff.body.suggestions).toHaveLength(0);

    // 6) 唯一有效封账约束在重启后仍成立
    const sealedCount = await ds.query(
      `SELECT count(*)::int AS c FROM monthly_bills
        WHERE elder_id = 'E-BILL-FEB' AND bill_month = '2024-02' AND status = 'SEALED'`,
    );
    expect(sealedCount[0].c).toBe(1);
  });

  // ---------------------------------------------------------------------------
  it('OpenAPI 文档可获取', async () => {
    const doc = await http.get('/api/docs/openapi.json').expect(200);
    expect(doc.body.openapi).toMatch(/^3\./);
    expect(doc.body.paths['/bills/{id}/seal']).toBeTruthy();
    expect(doc.body.paths['/bills/{id}/reopen']).toBeTruthy();
    expect(doc.body.paths['/bills/{id}/diff']).toBeTruthy();
    expect(
      doc.body.components.schemas.MonthlyBill.properties.status.enum,
    ).toEqual(['DRAFT', 'TRIALED', 'SEALED', 'REOPENED', 'SUPERSEDED']);
  });
});
