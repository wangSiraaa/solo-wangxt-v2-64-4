import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** YYYY-MM（服务端再按真实日历校验月份并推导闰月天数） */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export class BillMonthParamDto {
  @IsString()
  @MaxLength(64)
  elderId: string;

  @Matches(MONTH_RE, { message: 'billMonth 必须为 YYYY-MM' })
  billMonth: string;
}

export class TrialBillDto {
  @IsString()
  @MaxLength(64)
  elderId: string;

  @Matches(MONTH_RE, { message: 'billMonth 必须为 YYYY-MM' })
  billMonth: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  actor?: string;
}

export class CloseBillDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  actor?: string;

  /** 封账备注（可选），原因留痕于事件 */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}

export class ReopenBillDto {
  /** 重开必须给出原因 */
  @IsString()
  @MaxLength(1000)
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  actor?: string;
}

export class BillListQueryDto {
  @IsString()
  @MaxLength(64)
  elderId: string;

  @IsOptional()
  @Matches(MONTH_RE, { message: 'billMonth 必须为 YYYY-MM' })
  billMonth?: string;
}
