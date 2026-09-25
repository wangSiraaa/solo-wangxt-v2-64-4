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
10. **月度账单可封账闭环**：账单按 老人×自然月 版本化，状态机
    `DRAFT → TRIALED → CLOSED → REOPENED（旧版定格，派生新版本 TRIALED）→ SUPERSEDED`。
    - 封账冻结四类快照：**等级期间、日费版本、家属告知、逐日明细**（逐行携带等级期间 id 与日费版本 id，重启后每日来源可回放）；
    - 封账后数据变化（费率补录、评估更正）**绝不静默改写已封账金额**，差异只生成 `OPEN` 跨期调整建议（`RATE_CHANGED`/`GRADE_CHANGED`，逐天冻结值/现值/差额），差异消失自动撤销；
    - 重开**必须填写原因**，从原封账快照派生 `version_no+1` 的新版本（当前数据重算）；重算失败事务整体回滚，**旧封账保持可用、无新版本/半套明细**，并留 `RECOMPUTE_FAILED` 事件；
    - 新版本再封账后旧版变 `SUPERSEDED`，其未决调整建议自动置 `INCORPORATED` 并指向新版本；
    - 并发安全：服务端事务 + 行锁 + `pg_advisory_xact_lock(老人×月份)` 串行化，
      数据库部分唯一索引兜底——同月份最多一个工作版本（`DRAFT/TRIALED`）、最多一个有效封账（`CLOSED`）；
      重复封账/重复试算幂等回放，重复/并发重开仅产生一个新版本；
    - 全部生命周期（试算/封账/重开/替代/调整建议/重算失败）写审计事件，版本链双向指针（`derivedFromBillId` / `supersededByBillId`），重启可回放；
    - 未封账的 `GET /fees/segments` 查询行为与响应结构保持完全兼容（仍按当前数据实时计算）。

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
| GET | `/fees/segments?elderId=&from=&to=` | 按天分段费用与 decimal 合计（未封账原费用查询，兼容） |
| POST | `/billing/bills/trial` | 试算：`{elderId, billMonth:"YYYY-MM", actor?}` → 生成/幂等刷新工作版本（TRIALED） |
| GET | `/billing/bills?elderId=&billMonth?=` | 版本链：列出老人全部账单版本（按月份/版本号） |
| GET | `/billing/bills/:billId` | 账单详情：状态/合计/冻结快照/逐日明细/合并分段/调整建议/事件 |
| POST | `/billing/bills/:billId/close` | 封账：封账前重算并冻结四类快照；重复封账幂等回放 |
| POST | `/billing/bills/:billId/reopen` | 重开：`{reason, actor?}` 必填原因，旧版 REOPENED + 派生新版本 |
| POST | `/billing/bills/:billId/diff` | 差异查询：冻结基线 vs 当前数据，只生成/刷新 OPEN 调整建议 |
| GET | `/openapi.json` | OpenAPI 3.0 描述文档（零依赖程序化构建） |

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
- 闰月 2024-02（29 天）分段金额、跨 2024-01-01 调价日同等级二次分段、无等级空洞段、非法闰日期拒绝。

### 月度账单闭环 e2e（`test/billing.e2e-spec.ts`）

- 闰月内月中换级（2/1~2/14 LIGHT@100、2/15~2/29 SEVERE@300，29 天守恒）试算封出逐行/分段可解释明细，封账冻结等级期间/日费版本/告知/逐日明细四类快照；
- 重复试算刷新同一工作版本；重复/并发试算与封账仅一个版本且仅一个有效 `CLOSED`；封账后绕过重开另起草稿 409；
- 封账后补录费率（LIGHT 100→120）：原账 5900.00 与快照不变，diff 逐天生成 14 条 `RATE_CHANGED` 建议（+280.00，幂等不重复挂账）；`/fees/segments` 仍按当前数据返回 6180.00；
- 重开缺原因 400；注入重算失败 → 422 且旧封账仍 CLOSED 可用、无新版本、29 行明细完好、留 `RECOMPUTE_FAILED` 事件；
- 正常重开派生 v2（TRIALED，当前口径 6180.00）；并发重开仅一个新版本；封 v2 后 v1 `SUPERSEDED`、调整建议 `INCORPORATED` 指向 v2、版本链指针双向闭合；
- 封账后评估更正（等级期间 LIGHT→MODERATE）生成 `GRADE_CHANGED` 建议（+1120.00）原账不变；数据恢复后 OPEN 建议自动撤销；
- 重启 Nest 应用后：版本状态/金额、逐日来源 id、快照、调整关系与事件链完整回放，`/fees/segments` 兼容结构不变。
