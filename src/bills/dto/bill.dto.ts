import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** 账单月份固定为 YYYY-MM（公历月，闰月等天数由计费层处理） */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export class CreateBillDto {
  @IsString()
  @MaxLength(64)
  elderId: string;

  @Matches(MONTH, { message: 'billMonth 必须为 YYYY-MM 格式' })
  billMonth: string;
}

export class TrialBillDto {
  /** 故障注入：模拟试算/重算过程失败（不得留下半套明细） */
  @IsOptional()
  simulateRecomputeFailure?: boolean;
}

export class SealBillDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sealedBy?: string;
}

export class ReopenBillDto {
  /** 重开原因（必填，纯空白也拒绝） */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2, { message: '重开必须填写原因' })
  @MaxLength(500)
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  reopenedBy?: string;

  /** 故障注入：模拟派生新版本后的重算失败（旧封账必须仍可用） */
  @IsOptional()
  simulateRecomputeFailure?: boolean;
}
