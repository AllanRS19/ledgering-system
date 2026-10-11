import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';

@Module({
  exports: [LedgerService],
  providers: [LedgerService],
})
export class LedgerModule {}
