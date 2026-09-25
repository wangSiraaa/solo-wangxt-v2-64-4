/**
 * OpenAPI 3.0.3 文档（零依赖程序化构建，避免离线环境安装 @nestjs/swagger）。
 * 描述既有评估/复核/告知/费用接口与新增月度账单闭环接口。
 * 访问：GET /api/openapi.json
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: '养老机构评估-复核-告知-费用生效-月度封账 API',
      version: '1.1.0',
      description:
        '虚构量表行政流程演示（非医疗诊断）。月度账单状态机：' +
        'DRAFT → TRIALED → CLOSED → REOPENED（派生新版本）→ SUPERSEDED。' +
        '封账冻结等级期间/日费版本/告知/逐日明细快照；后续数据变化不改账，只生成跨期调整建议。',
    },
    servers: [{ url: '/api' }],
    tags: [
      { name: 'assessments', description: '评估/复核/告知' },
      { name: 'fees', description: '等级生效与按天分段费用' },
      { name: 'billing', description: '月度账单闭环（试算/封账/重开/差异）' },
    ],
    paths: {
      '/scales/{id}': {
        get: {
          tags: ['assessments'],
          summary: '量表版本、原始条目/选项、NA 分母策略、定级阈值',
          parameters: [{ $ref: '#/components/parameters/scaleId' }],
          responses: { '200': { description: '量表版本' } },
        },
      },
      '/assessments': {
        post: {
          tags: ['assessments'],
          summary: '提交两位评估员作答 → INCOMPLETE / CONFIRMED / PENDING_REVIEW',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitAssessmentRequest' } } } },
          responses: { '201': { description: '评估案件（含逐项评分解释）' } },
        },
      },
      '/assessments/{id}': {
        get: {
          tags: ['assessments'],
          summary: '案件 + 逐项评分来源 + 复核意见 + 告知记录',
          parameters: [{ $ref: '#/components/parameters/caseId' }],
          responses: { '200': { description: '案件详情' } },
        },
      },
      '/assessments/{id}/review/confirm': {
        post: {
          tags: ['assessments'],
          summary: '管理复核（等级限候选内，支持 idempotencyKey）',
          parameters: [{ $ref: '#/components/parameters/caseId' }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ConfirmReviewRequest' } } } },
          responses: {
            '201': { description: '确认结果（replayed 标记幂等回放）' },
            '400': { $ref: '#/components/responses/Error' },
            '409': { $ref: '#/components/responses/Error' },
          },
        },
      },
      '/assessments/{id}/notification/attempt': {
        post: {
          tags: ['assessments'],
          summary: '家属告知尝试（simulateFail 模拟通道失败）',
          parameters: [{ $ref: '#/components/parameters/caseId' }],
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NotifyAttemptRequest' } } } },
          responses: { '201': { description: '本次告知记录' } },
        },
      },
      '/assessments/{id}/notification': {
        get: {
          tags: ['assessments'],
          summary: '全部告知记录（失败历史、未确认尝试均保留）',
          parameters: [{ $ref: '#/components/parameters/caseId' }],
          responses: { '200': { description: '告知记录列表' } },
        },
      },
      '/fees/activate': {
        post: {
          tags: ['fees'],
          summary: '等级生效（必须已确认；同日不允许重叠等级）',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ActivateGradeRequest' } } } },
          responses: {
            '201': { description: '生效结果（replayed 标记幂等回放）' },
            '409': { $ref: '#/components/responses/Error' },
          },
        },
      },
      '/fees/segments': {
        get: {
          tags: ['fees'],
          summary: '按天分段费用与 decimal 合计（未封账原费用查询，行为保持兼容）',
          parameters: [
            { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } },
          ],
          responses: { '200': { description: '费用分段', content: { 'application/json': { schema: { $ref: '#/components/schemas/FeeSegmentsResponse' } } } } },
        },
      },
      // ---------------- 月度账单闭环 ----------------
      '/billing/bills': {
        get: {
          tags: ['billing'],
          summary: '版本链：按老人（可再按月份）列出全部账单版本',
          parameters: [
            { name: 'elderId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'billMonth', in: 'query', required: false, schema: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } },
          ],
          responses: { '200': { description: '账单版本列表', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/MonthlyBillSummary' } } } } } },
        },
      },
      '/billing/bills/trial': {
        post: {
          tags: ['billing'],
          summary: '试算：生成草稿并完成试算（重复调用幂等刷新同一工作版本）',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TrialBillRequest' } } } },
          responses: {
            '201': { description: '试算账单（replayed=true 表示刷新既有工作版本）', content: { 'application/json': { schema: { $ref: '#/components/schemas/TrialBillResponse' } } } },
            '409': { $ref: '#/components/responses/Error' },
          },
        },
      },
      '/billing/bills/{billId}': {
        get: {
          tags: ['billing'],
          summary: '账单详情：状态/合计/冻结快照/逐日明细/合并分段/调整建议/事件',
          parameters: [{ $ref: '#/components/parameters/billId' }],
          responses: { '200': { description: '账单详情', content: { 'application/json': { schema: { $ref: '#/components/schemas/BillDetail' } } } }, '404': { $ref: '#/components/responses/Error' } },
        },
      },
      '/billing/bills/{billId}/close': {
        post: {
          tags: ['billing'],
          summary: '封账：TRIALED → CLOSED，冻结快照；重复封账幂等回放，并发仅一个有效版本',
          parameters: [{ $ref: '#/components/parameters/billId' }],
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CloseBillRequest' } } } },
          responses: {
            '201': { description: '封账结果（replayed=true 表示重复封账回放）', content: { 'application/json': { schema: { $ref: '#/components/schemas/CloseBillResponse' } } } },
            '409': { $ref: '#/components/responses/Error' },
          },
        },
      },
      '/billing/bills/{billId}/reopen': {
        post: {
          tags: ['billing'],
          summary: '重开：必须填写原因；旧封账 REOPENED 定格，从原快照派生新版本 TRIALED',
          description:
            '重算失败时整体回滚：不产生新版本/半套明细，旧封账保持 CLOSED 可用（422 BILL_RECOMPUTE_FAILED）。',
          parameters: [{ $ref: '#/components/parameters/billId' }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ReopenBillRequest' } } } },
          responses: {
            '201': { description: '旧版 + 派生新版本', content: { 'application/json': { schema: { $ref: '#/components/schemas/ReopenBillResponse' } } } },
            '409': { $ref: '#/components/responses/Error' },
            '422': { $ref: '#/components/responses/Error' },
          },
        },
      },
      '/billing/bills/{billId}/diff': {
        post: {
          tags: ['billing'],
          summary: '差异查询：封账基线 vs 当前数据，只生成跨期调整建议，原账不变',
          parameters: [{ $ref: '#/components/parameters/billId' }],
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/DiffRequest' } } } },
          responses: {
            '201': { description: '差异与调整建议', content: { 'application/json': { schema: { $ref: '#/components/schemas/DiffResponse' } } } },
            '409': { $ref: '#/components/responses/Error' },
          },
        },
      },
    },
    components: {
      parameters: {
        scaleId: { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        caseId: { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        billId: { name: 'billId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      },
      responses: {
        Error: {
          description: '错误响应（body 为 {statusCode,error,message}，message 可携带 code）',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            statusCode: { type: 'integer' },
            error: { type: 'string' },
            message: { oneOf: [{ type: 'string' }, { type: 'object' }] },
          },
        },
        SubmitAssessmentRequest: {
          type: 'object',
          required: ['elderId', 'elderName', 'familyContact', 'assessors'],
          properties: {
            elderId: { type: 'string' },
            elderName: { type: 'string' },
            familyContact: { type: 'string' },
            assessors: {
              type: 'array',
              items: {
                type: 'object',
                required: ['assessorId', 'answers'],
                properties: {
                  assessorId: { type: 'integer' },
                  answers: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        itemCode: { type: 'string' },
                        optionCode: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        ConfirmReviewRequest: {
          type: 'object',
          required: ['confirmedGrade', 'reviewerId', 'comment'],
          properties: {
            confirmedGrade: { type: 'string', enum: ['LIGHT', 'MODERATE', 'SEVERE'] },
            reviewerId: { type: 'string' },
            comment: { type: 'string' },
            idempotencyKey: { type: 'string' },
          },
        },
        NotifyAttemptRequest: {
          type: 'object',
          properties: { simulateFail: { type: 'boolean' } },
        },
        ActivateGradeRequest: {
          type: 'object',
          required: ['caseId', 'effectiveDate'],
          properties: {
            caseId: { type: 'string', format: 'uuid' },
            effectiveDate: { type: 'string', format: 'date' },
            idempotencyKey: { type: 'string' },
          },
        },
        FeeSegmentsResponse: {
          type: 'object',
          properties: {
            elderId: { type: 'string' },
            from: { type: 'string', format: 'date' },
            to: { type: 'string', format: 'date' },
            totalDays: { type: 'integer' },
            totalAmount: { type: 'string', description: 'decimal 两位小数' },
            segments: { type: 'array', items: { $ref: '#/components/schemas/FeeSegment' } },
          },
        },
        FeeSegment: {
          type: 'object',
          properties: {
            startDate: { type: 'string', format: 'date' },
            endDate: { type: 'string', format: 'date' },
            days: { type: 'integer' },
            grade: { type: 'string', nullable: true, enum: ['LIGHT', 'MODERATE', 'SEVERE'] },
            dailyRate: { type: 'string', nullable: true },
            amount: { type: 'string' },
            source: { type: 'string', enum: ['GRADE_PERIOD_AND_RATE', 'GRADE_PERIOD_NO_RATE', 'NO_EFFECTIVE_GRADE'] },
            gradePeriodId: { type: 'string', format: 'uuid', nullable: true },
            rateEffectiveFrom: { type: 'string', format: 'date', nullable: true },
            note: { type: 'string' },
          },
        },
        TrialBillRequest: {
          type: 'object',
          required: ['elderId', 'billMonth'],
          properties: {
            elderId: { type: 'string' },
            billMonth: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', example: '2024-02' },
            actor: { type: 'string' },
          },
        },
        CloseBillRequest: {
          type: 'object',
          properties: {
            actor: { type: 'string' },
            comment: { type: 'string', maxLength: 500 },
          },
        },
        ReopenBillRequest: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', maxLength: 1000 }, actor: { type: 'string' } },
        },
        DiffRequest: {
          type: 'object',
          properties: { actor: { type: 'string' } },
        },
        MonthlyBillSummary: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            elderId: { type: 'string' },
            billMonth: { type: 'string' },
            periodStart: { type: 'string', format: 'date' },
            periodEnd: { type: 'string', format: 'date' },
            versionNo: { type: 'integer' },
            status: { type: 'string', enum: ['DRAFT', 'TRIALED', 'CLOSED', 'REOPENED', 'SUPERSEDED'] },
            totalAmount: { type: 'string' },
            totalDays: { type: 'integer' },
            derivedFromBillId: { type: 'string', format: 'uuid', nullable: true },
            supersededByBillId: { type: 'string', format: 'uuid', nullable: true },
          },
        },
        BillSnapshot: {
          type: 'object',
          properties: {
            frozenAt: { type: 'string', format: 'date-time' },
            gradePeriods: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  grade: { type: 'string' },
                  startDate: { type: 'string', format: 'date' },
                  endDateExclusive: { type: 'string', format: 'date', nullable: true },
                  sourceCaseId: { type: 'string', format: 'uuid' },
                },
              },
            },
            rateVersions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  grade: { type: 'string' },
                  effectiveFrom: { type: 'string', format: 'date' },
                  dailyRate: { type: 'string' },
                  note: { type: 'string', nullable: true },
                },
              },
            },
            notifications: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  status: { type: 'string' },
                  notifiableStatus: { type: 'string' },
                  attempts: { type: 'integer' },
                  lastAttemptAt: { type: 'string', format: 'date-time', nullable: true },
                  failureReason: { type: 'string', nullable: true },
                  message: { type: 'string', nullable: true },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        BillDailyLine: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            billId: { type: 'string', format: 'uuid' },
            lineDate: { type: 'string', format: 'date' },
            grade: { type: 'string', nullable: true },
            dailyRate: { type: 'string', nullable: true },
            amount: { type: 'string' },
            source: { type: 'string' },
            note: { type: 'string' },
            gradePeriodId: { type: 'string', format: 'uuid', nullable: true },
            rateVersionId: { type: 'string', format: 'uuid', nullable: true },
            rateEffectiveFrom: { type: 'string', format: 'date', nullable: true },
          },
        },
        AdjustmentSuggestion: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            billId: { type: 'string', format: 'uuid' },
            adjustmentType: { type: 'string', enum: ['RATE_CHANGED', 'GRADE_CHANGED'] },
            lineDate: { type: 'string', format: 'date' },
            frozenAmount: { type: 'string' },
            currentAmount: { type: 'string' },
            deltaAmount: { type: 'string', description: '正补收/负退减' },
            frozenGrade: { type: 'string', nullable: true },
            currentGrade: { type: 'string', nullable: true },
            frozenDailyRate: { type: 'string', nullable: true },
            currentDailyRate: { type: 'string', nullable: true },
            note: { type: 'string' },
            status: { type: 'string', enum: ['OPEN', 'INCORPORATED'] },
            resolvedByBillId: { type: 'string', format: 'uuid', nullable: true },
          },
        },
        BillEvent: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            billId: { type: 'string', format: 'uuid' },
            eventType: {
              type: 'string',
              enum: ['TRIALED', 'CLOSED', 'REOPENED', 'SUPERSEDED', 'ADJUSTMENT_PROPOSED', 'ADJUSTMENT_INCORPORATED', 'RECOMPUTE_FAILED'],
            },
            actor: { type: 'string' },
            reason: { type: 'string', nullable: true },
            payload: { type: 'object', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        BillDetail: {
          allOf: [
            { $ref: '#/components/schemas/MonthlyBillSummary' },
            {
              type: 'object',
              properties: {
                reopenReason: { type: 'string', nullable: true },
                frozen: { type: 'boolean' },
                snapshot: { oneOf: [{ $ref: '#/components/schemas/BillSnapshot' }, { type: 'null' }] },
                lines: { type: 'array', items: { $ref: '#/components/schemas/BillDailyLine' } },
                segments: { type: 'array', items: { $ref: '#/components/schemas/FeeSegment' } },
                suggestions: { type: 'array', items: { $ref: '#/components/schemas/AdjustmentSuggestion' } },
                events: { type: 'array', items: { $ref: '#/components/schemas/BillEvent' } },
              },
            },
          ],
        },
        TrialBillResponse: {
          type: 'object',
          properties: {
            replayed: { type: 'boolean' },
            bill: { $ref: '#/components/schemas/BillDetail' },
          },
        },
        CloseBillResponse: {
          type: 'object',
          properties: {
            replayed: { type: 'boolean' },
            bill: { $ref: '#/components/schemas/BillDetail' },
          },
        },
        ReopenBillResponse: {
          type: 'object',
          properties: {
            predecessor: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                status: { type: 'string', enum: ['REOPENED'] },
                versionNo: { type: 'integer' },
              },
            },
            successor: { $ref: '#/components/schemas/BillDetail' },
          },
        },
        DiffResponse: {
          type: 'object',
          properties: {
            billId: { type: 'string', format: 'uuid' },
            billMonth: { type: 'string' },
            versionNo: { type: 'integer' },
            status: { type: 'string' },
            frozenAmount: { type: 'string' },
            currentAmount: { type: 'string' },
            deltaAmount: { type: 'string' },
            openDeltaAmount: { type: 'string' },
            changedDays: { type: 'integer' },
            readOnly: { type: 'boolean' },
            message: { type: 'string' },
            suggestions: { type: 'array', items: { $ref: '#/components/schemas/AdjustmentSuggestion' } },
            notificationChanges: { type: 'object' },
          },
        },
      },
    },
  };
}
