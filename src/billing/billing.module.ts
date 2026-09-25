import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MonthlyBill } from '../entities/monthly-bill.entity';
import { BillDailyLine } from '../entities/bill-daily-line.entity';
import { BillAdjustmentSuggestion } from '../entities/bill-adjustment-suggestion.entity';
import { MonthlyBillEvent } from '../entities/monthly-bill-event.entity';
import { FeesModule } from '../fees/fees.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MonthlyBill,
      BillDailyLine,
      BillAdjustmentSuggestion,
      MonthlyBillEvent,
    ]),
    FeesModule,
  ],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
