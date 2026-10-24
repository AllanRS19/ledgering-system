import { Authenticate, CurrentUser } from '@nestjs/authentication';
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ListTransactionsQueryDto } from './dto/list-transactions.dto';
import { ListEntriesQueryDto } from './dto/list-entries.dto';
import { HistoryService } from './history.service';

// No path prefix here: the two routes belong to different "areas" of the API
// (transactions, and a wallet's statement), so each declares its own path.
@Authenticate({ verifiedEmail: true })
@Controller()
export class HistoryController {
  constructor(private readonly historyService: HistoryService) {}

  // GET /transactions?limit=&cursor=&type=&status=&walletId=&from=&to=
  @Get('transactions')
  listTransactions(
    @Query() query: ListTransactionsQueryDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.historyService.listTransactions(userId, query);
  }

  // GET /wallets/:walletId/entries?limit=&cursor=&from=&to=
  @Get('wallets/:walletId/entries')
  listEntries(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query() query: ListEntriesQueryDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.historyService.listEntries(userId, walletId, query);
  }
}
