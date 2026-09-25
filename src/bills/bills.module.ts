import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MonthlyBill } from '../entities/monthly-bill.entity';
import { BillDailyLine } from '../entities/bill-daily-line.entity';
import { BillAdjustmentSuggestion } from '../entities/bill-adjustment-suggestion.entity';
import { BillsController } from './bills.controller';
import { DocsController } from './docs.controller';
import { BillsService } from './bills.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MonthlyBill,
      BillDailyLine,
      BillAdjustmentSuggestion,
    ]),
  ],
  controllers: [BillsController, DocsController],
  providers: [BillsService],
})
export class BillsModule {}
