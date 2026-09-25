import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { BillingService } from './billing.service';
import {
  BillListQueryDto,
  CloseBillDto,
  ReopenBillDto,
  TrialBillDto,
} from './dto/billing.dto';

/**
 * 月度账单闭环：试算 → 封账（冻结快照）→ 差异（只提调整）→ 重开（派生新版本）→ 再封账。
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly service: BillingService) {}

  /** 版本链：按老人（可再按月份）列出全部账单版本，按月份/版本号升序 */
  @Get('bills')
  list(@Query() q: BillListQueryDto) {
    return this.service.list(q);
  }

  /** 试算：生成草稿并完成试算（重复调用幂等刷新同一工作版本） */
  @Post('bills/trial')
  trial(@Body() dto: TrialBillDto) {
    return this.service.trial(dto);
  }

  /** 账单详情：状态/合计/冻结快照/逐日明细/合并分段/调整建议/事件版本链 */
  @Get('bills/:billId')
  get(@Param('billId', new ParseUUIDPipe()) billId: string) {
    return this.service.get(billId);
  }

  /** 封账：TRIALED → CLOSED，冻结等级期间/日费版本/告知/逐日明细快照 */
  @Post('bills/:billId/close')
  close(
    @Param('billId', new ParseUUIDPipe()) billId: string,
    @Body() dto: CloseBillDto,
  ) {
    return this.service.close(billId, dto ?? {});
  }

  /** 重开：必须填写原因，旧封账 REOPENED 定格，从原快照派生新版本（TRIALED） */
  @Post('bills/:billId/reopen')
  reopen(
    @Param('billId', new ParseUUIDPipe()) billId: string,
    @Body() dto: ReopenBillDto,
  ) {
    return this.service.reopen(billId, dto);
  }

  /**
   * 差异查询：已封账基线 vs 当前数据。
   * 不静默改写已封账金额；金额差异只生成/刷新 OPEN 跨期调整建议。
   */
  @Post('bills/:billId/diff')
  diff(
    @Param('billId', new ParseUUIDPipe()) billId: string,
    @Body() body: { actor?: string } | undefined,
  ) {
    return this.service.diff(billId, body?.actor ?? 'SYSTEM');
  }
}
