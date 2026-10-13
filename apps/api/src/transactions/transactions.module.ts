import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  exports: [TransactionsService],
  providers: [TransactionsService],
  controllers: [TransactionsController],
})
export class TransactionsModule {}
