import { Authenticate, CurrentUser } from '@nestjs/authentication';
import { Body, Controller, Post } from '@nestjs/common';
import { DepositFundsDto } from './dto/deposit.dto';
import { TransactionsService } from './transactions.service';
import type { User } from '../users/types/user.types';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';

@Authenticate({ verifiedEmail: true })
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post('deposits')
  deposit(
    @Body() dto: DepositFundsDto,
    @CurrentUser() user: User,
    @IdempotencyKey() idempotencyKey: string,
  ) {
    // The DTO already guarantees the string is a valid amount, so BigInt()
    // is safe here and the service only ever sees a bigint.
    return this.transactionsService.depositFunds({
      userId: user.id,
      walletId: dto.walletId,
      amount: BigInt(dto.amount),
      idempotencyKey,
    });
  }
}
