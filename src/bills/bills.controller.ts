import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { BillsService } from './bills.service';
import {
  CreateBillDto,
  ReopenBillDto,
  SealBillDto,
  TrialBillDto,
} from './dto/bill.dto';
import { BillAdjustmentStatus } from '../common/enums';

/**
 * 月度账单闭环：草稿 → 试算 → 封账 →（重开 → 新版本）→ 替代。
 * 封账即冻结等级期间/日费版本/告知快照与逐日明细；
 * 封账后数据变化只经 /diff 产生跨期调整建议，不改写已封账金额。
 */
@Controller('bills')
export class BillsController {
  constructor(private readonly service: BillsService) {}

  /** 创建（或幂等回放）某月账单草稿 */
  @Post()
  create(@Body() dto: CreateBillDto) {
    return this.service.createDraft(dto.elderId, dto.billMonth);
  }

  /** 账单列表（可按老人/月份过滤） */
  @Get()
  list(
    @Query('elderId') elderId?: string,
    @Query('billMonth') billMonth?: string,
  ) {
    return this.service.list(elderId, billMonth);
  }

  /** 版本链回放：同一老人月份的全部版本、派生关系与当前有效版本 */
  @Get('chain/:elderId/:billMonth')
  chain(
    @Param('elderId') elderId: string,
    @Param('billMonth') billMonth: string,
  ) {
    return this.service.chain(elderId, billMonth);
  }

  /** 跨期调整建议列表（可按状态 / 账单过滤） */
  @Get('adjustments')
  adjustments(
    @Query('status') status?: BillAdjustmentStatus,
    @Query('billId') billId?: string,
  ) {
    return this.service.adjustments(status, billId);
  }

  /** 账单详情：状态/汇总 + 封账快照摘要（期间/日费/告知冻结值） */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  /** 逐日明细（每日来源：等级期间 id + 日费版本 id/生效日） */
  @Get(':id/lines')
  lines(@Param('id') id: string) {
    return this.service.lines(id);
  }

  /**
   * 差异查询：封账快照 vs 当前实时数据，
   * 生成/刷新跨期调整建议（费率补录 RATE_BACKFILL / 评估更正 GRADE_PERIOD_CHANGE）。
   */
  @Get(':id/diff')
  diff(@Param('id') id: string) {
    return this.service.diff(id);
  }

  /** 试算：整月逐日重算并写入试算明细（不封账） */
  @Post(':id/trial')
  trial(@Param('id') id: string, @Body() dto: TrialBillDto) {
    return this.service.trial(id, dto ?? {});
  }

  /** 封账：冻结快照与逐日明细（来源自试算后变化则拒绝） */
  @Post(':id/seal')
  seal(@Param('id') id: string, @Body() dto: SealBillDto) {
    return this.service.seal(id, dto ?? {});
  }

  /** 重开：必须填写原因；旧封账 → REOPENED，从快照派生新版本草稿 */
  @Post(':id/reopen')
  reopen(@Param('id') id: string, @Body() dto: ReopenBillDto) {
    return this.service.reopen(id, dto);
  }
}
