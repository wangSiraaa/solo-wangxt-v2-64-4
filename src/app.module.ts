import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  buildDataSourceOptions,
  ensureSchema,
  entities,
} from './database/data-source';
import { seedDemoData } from './database/seed';
import { ScalesModule } from './scales/scales.module';
import { AssessmentsModule } from './assessments/assessments.module';
import { ReviewsModule } from './reviews/reviews.module';
import { NotificationsModule } from './notifications/notifications.module';
import { FeesModule } from './fees/fees.module';
import { BillingModule } from './billing/billing.module';
import { OpenApiModule } from './openapi/openapi.module';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: async () => {
        const options = buildDataSourceOptions();
        // 初始化连接只做 DDL/种子，完成后释放；连接池交给 TypeOrmModule
        const ds = new DataSource(options);
        await ds.initialize();
        await ensureSchema(ds);
        await seedDemoData(ds);
        await ds.destroy();
        return { ...options, entities };
      },
    }),
    ScalesModule,
    AssessmentsModule,
    ReviewsModule,
    NotificationsModule,
    FeesModule,
    BillingModule,
    OpenApiModule,
  ],
})
export class AppModule {}
