# 养老机构评估 → 管理复核 → 家属告知 → 费用生效（服务端流程演示）

NestJS + PostgreSQL + TypeORM + decimal.js 的服务端流程。**无前端**。

> ⚠️ 本项目使用**虚构量表 DEMO_ADL**，仅用于行政流程（评估、复核、告知、计费）演示，
> **不构成医疗诊断、护理分级依据或真实护理建议**。该声明同时固化在量表版本与每条家属告知文本中。

## 流程规则（对应业务要求）

1. **必填项缺失不得自动定级**：任一评估员必填条目缺失/无效/误用 NA，案件为 `INCOMPLETE`，无确认等级，不能复核、不能费用生效。
2. **不适用项（NA）如何影响分母由量表定义**：`scale_versions.na_policy` 决定。演示量表为 `EXCLUDE_FROM_DENOMINATOR`，且仅 `STAIRS`、`OUTDOOR` 两题允许 NA；对不允许 NA 的题选 NA 视为无效作答。
3. **两位评估员结果冲突进入复核，不能简单取较高等级**：等级不一致 → `PENDING_REVIEW`；管理员必须在**两位评估员候选等级之内**显式选择并填写意见。取候选外等级（如“折中”）返回 400。
4. **等级确认后生成告知记录**：一致由系统确认（reviewer=`SYSTEM`），冲突由管理员确认；确认即生成一条 `PENDING / CONFIRMED` 告知。
5. **送达失败与尚未确认分别记录**：
   - 送达结果 `status`：`PENDING / DELIVERED / FAILED`（失败原因独立留痕，每次尝试一行）；
   - 可告知状态 `notifiableStatus`：`CONFIRMED / UNCONFIRMED`。尚未确认时也可尝试告知，落 `UNCONFIRMED + FAILED（等级尚未确认）`。
6. **费用生效按机构示例规则独立判断**：等级是否已确认才是生效前提，与家属告知是否送达无关。
7. **同一天不能出现重叠生效等级**：服务层显式校验 + PostgreSQL `btree_gist` 的 daterange 排他约束双保险。月中换级时旧期间自动截至生效日前一日（半开区间首尾相接）。
8. **费用按天分段**：等级期间 × 日费版本切换日二次切分，闭区间逐天连续（含无生效等级空洞段），天数守恒校验；金额一律 decimal.js 计算，两位小数 `ROUND_HALF_UP`。
9. **接口可解释**：评估响应内嵌两位评估员逐项明细（原始选项、分值、是否计入分母、NA 说明、原始分/有效分母/百分比/定级阈值）；费用分段逐段给出等级、日费版本、天数、金额与来源。

### 月度账单闭环（封账、重开与跨期调整）

10. **账单版本状态机**：`DRAFT 草稿 → TRIALED 已试算 → SEALED 已封账`；封账后重开旧版本转为 `REOPENED 已重开`，同时从原快照派生新版本草稿；新版本封账后旧版本转为 `SUPERSEDED 已替代`。同一老人同一月份**始终至多一个 SEALED 有效版本**。
11. **封账即冻结**：封账时冻结等级期间、日费版本、告知记录快照（`sealed_snapshot` jsonb）与逐日明细（月内每天一行的 `bill_daily_lines`）。试算后来源若再变化（指纹不一致）拒绝封账，必须重新试算；封账后等级/费率数据变化**绝不静默改写**已封账金额与明细。
12. **跨期调整建议**：封账后补录费率（`RATE_BACKFILL`）或评估更正导致等级期间变化（`GRADE_PERIOD_CHANGE`），仅由差异查询 `GET /bills/:id/diff` 按“冻结快照逐日 vs 当前实时逐日”比对，聚合为 `bill_adjustment_suggestions` 建议（含起止日、天数、旧账金额、重算金额、差额与原因）；后续重开并封账新版本吸收差异后，旧建议置 `SUPERSEDED`。
13. **重开必须给原因**：`reason` 必填；旧版本冻结数据保留可查（重算失败时仍是兜底），新版本从旧快照逐日明细整行派生。试算/重算先在内存完成、事务内整删整插，任何失败（含 `simulateRecomputeFailure` 注入）整体回滚，**不留半套明细**。
14. **并发与重复防护**：事务级 `pg_advisory_xact_lock`（按老人+月份串行化）+ 行锁 `FOR UPDATE` + 部分唯一索引（`... WHERE status='SEALED'`、`... WHERE status IN ('DRAFT','TRIALED')`）三重保证；重复封账、并发重开均只一个版本有效。
15. **可回放/可迁移**：幂等 DDL 迁移（`ensureBillingSchema`）；重启后版本链（predecessor/successor）、每日来源（`grade_period_id` + `rate_version_id`）、封账快照与调整关系均可回放。未封账的 `/fees/segments` 实时查询结果结构保持不变。

> OpenAPI 3.0 文档：`docs/openapi.json`，运行后可通过 `GET /api/docs/openapi.json` 获取。

## 演示数据

- 量表 `DEMO_ADL v1.0.0`：10 题（8 必填 + STAIRS/OUTDOOR 可 NA），0~3 分制；
  百分比阈值 `<40% LIGHT / [40%,70%) MODERATE / >=70% SEVERE`。
- 示例日费（元/天）：LIGHT 100；MODERATE 180（2024-01-01 起 200）；SEVERE 260（2024-01-01 起 300）。

## 运行

无需系统 PostgreSQL / root：默认在项目内启动**用户态嵌入式 PostgreSQL 18**（`embedded-postgres`）。
如有外部 PG，在 `.env` 设置 `DB_HOST` 即切换为外部连接（见 `.env.example`）。

```bash
npm install
npm run seed          # 可选：仅建表+种子
npm run start         # http://127.0.0.1:3000/api
npm test              # e2e（自带嵌入式 PG，覆盖下列全部场景）
```

## API（均在 /api 前缀下）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/scales/:id` | 量表版本、原始条目/选项、NA 分母策略、定级阈值 |
| POST | `/assessments` | 提交两位评估员作答 → INCOMPLETE / CONFIRMED / PENDING_REVIEW |
| GET | `/assessments/:id` | 案件 + 逐项评分来源 + 复核意见 + 告知记录 |
| POST | `/assessments/:id/review/confirm` | 管理复核（等级限候选内，支持 `idempotencyKey`） |
| POST | `/assessments/:id/notification/attempt` | 家属告知尝试（`{"simulateFail":true}` 模拟通道失败） |
| GET | `/assessments/:id/notification` | 全部告知记录（失败历史、未确认尝试均保留） |
| POST | `/fees/activate` | 等级生效 `{caseId, effectiveDate}` |
| GET | `/fees/segments?elderId=&from=&to=` | 按天分段费用与 decimal 合计（实时，兼容） |
| POST | `/bills` | 创建/幂等回放月度账单草稿 `{elderId, billMonth}` |
| GET | `/bills?elderId=&billMonth=` | 账单版本列表 |
| GET | `/bills/chain/:elderId/:billMonth` | 版本链回放（派生关系 + 当前唯一有效版本） |
| GET | `/bills/:id` | 账单详情：状态/汇总 + 封账快照摘要 + 逐日明细 |
| GET | `/bills/:id/lines` | 逐日明细（每日等级期间/日费版本来源） |
| POST | `/bills/:id/trial` | 试算/重算（可 `{"simulateRecomputeFailure":true}` 注入失败） |
| POST | `/bills/:id/seal` | 封账 `{sealedBy?}`：冻结快照与逐日明细 |
| POST | `/bills/:id/reopen` | 重开（`reason` 必填）：旧版 REOPENED + 派生新版本草稿 |
| GET | `/bills/:id/diff` | 差异查询：生成跨期调整建议（不改写封账金额） |
| GET | `/bills/adjustments?status=&billId=` | 跨期调整建议列表（OPEN / SUPERSEDED） |
| GET | `/docs/openapi.json` | OpenAPI 3.0 文档 |

### 示例：月中升级 + 闰月

```bash
# 1) 轻度确认并 2024-01-01 生效（两位评估员全选独立完成）
curl -sXPOST localhost:3000/api/assessments -H 'Content-Type: application/json' -d '{
  "elderId":"E1","elderName":"张某","familyContact":"13900000000",
  "assessors":[{"assessorId":1,"answers":[{"itemCode":"TRANSFER","optionCode":"INDEPENDENT"}]},
               {"assessorId":2,"answers":[{"itemCode":"TRANSFER","optionCode":"INDEPENDENT"}]}]}'
# 全部 10 题均提交；冲突案件再 POST /review/confirm；然后：
curl -sXPOST localhost:3000/api/fees/activate -H 'Content-Type: application/json' \
  -d '{"caseId":"<case-uuid>","effectiveDate":"2024-02-15"}'
curl -s 'localhost:3000/api/fees/segments?elderId=E1&from=2024-02-01&to=2024-02-29'
# 2024 为闰年：2/1~2/14 与 2/15~2/29 两段，共 29 天
```

## e2e 覆盖场景

- 必填缺失 / 无效 NA → INCOMPLETE，不定级、不可复核生效；
- NA 从分母剔除（8 题 TOTAL_DEP + 2 NA → 分母 8 而非 10）及逐项解释；
- LIGHT vs SEVERE 冲突 → 复核候选外等级 400、显式选较低 LIGHT 成功（证明不取高）；
- 重复确认请求：相同幂等键回放、无键重复 409；
- 尚未确认尝试告知 → `UNCONFIRMED/FAILED`；送达失败原因分行留痕；
- 月中升级切旧区间、同案重复生效回放、同日不同等级重叠 409；
- 闰月 2024-02（29 天）分段金额、跨 2024-01-01 调价日同等级二次分段、无等级空洞段、非法闰日期拒绝；
- 月度账单闭环：闰月月中换级封出 29 天可解释明细并冻结快照；未试算不得封账；重复与并发封账仅一个有效版本；
- 封账后费率补录仅产生 RATE_BACKFILL 建议、评估更正产生 GRADE_PERIOD_CHANGE 建议，原账金额/明细不变；
- 重开必须给原因、并发重开仅一个新版本；重开后重算失败无半套明细且旧封账仍可用；新版本封账后旧版 SUPERSEDED、旧建议关闭；
- 试算后来源变化（指纹不一致）拒绝静默封账；重启应用后版本链、每日来源、快照与调整关系可回放；未封账费用查询保持兼容。
