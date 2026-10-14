import { IsUUID } from 'class-validator';
import { IsMinorUnitAmount } from '../../common/decorators/minor-unit-amount.decorator';

export class DepositFundsDto {
  @IsUUID()
  walletId!: string;

  // Custom decorator shared between deposit and transfer DTOs
  @IsMinorUnitAmount()
  amount!: string;
}
