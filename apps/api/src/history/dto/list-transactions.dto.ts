import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { PageQueryDto } from './page-query.dto';

/** Query string of GET /transactions. */
export class ListTransactionsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['DEPOSIT', 'TRANSFER'])
  type?: 'DEPOSIT' | 'TRANSFER';

  @IsOptional()
  @IsIn(['COMPLETED', 'FAILED'])
  status?: 'COMPLETED' | 'FAILED';

  // Must be one of the caller's own wallets: the service answers 404 otherwise.
  @IsOptional()
  @IsUUID()
  walletId?: string;
}
