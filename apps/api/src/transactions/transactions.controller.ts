import { Authenticate, CurrentUser } from '@nestjs/authentication';
import { Body, Controller, Post, Res } from '@nestjs/common';
import { DepositFundsDto } from './dto/deposit.dto';
import { TransactionsService } from './transactions.service';
import type { User } from '../users/types/user.types';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { TransferFundsDto } from './dto/transfer.dto';
import type { Response } from 'express';

const REPLAYED_HEADER = 'Idempotent-Replayed';

/** Tells the client this answer is the stored result of an earlier identical request. */
function markReplay(response: Response, replayed: boolean): void {
  if (replayed) {
    response.setHeader(REPLAYED_HEADER, 'true');
  }
}

@Authenticate({ verifiedEmail: true })
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  // passthrough: Nest still sends the returned value and the 201 status;
  // we only need the response object to set a header
  @Post('deposits')
  async deposit(
    @Body() dto: DepositFundsDto,
    @CurrentUser() user: User,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    // The DTO already guarantees the string is a valid amount, so BigInt()
    // is safe here and the service only ever sees a bigint.
    const { result, replayed } = await this.transactionsService.depositFunds({
      userId: user.id,
      walletId: dto.walletId,
      amount: BigInt(dto.amount),
      idempotencyKey,
    });

    markReplay(response, replayed);
    return result;
  }

  @Post('transfers')
  async transfer(
    @Body() dto: TransferFundsDto,
    @CurrentUser() user: User,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { result, replayed } = await this.transactionsService.transferFunds({
      userId: user.id,
      sourceWalletId: dto.sourceWalletId,
      destinationWalletId: dto.destinationWalletId,
      amount: BigInt(dto.amount),
      description: dto.description,
      idempotencyKey,
    });

    markReplay(response, replayed);
    return result;
  }
}
