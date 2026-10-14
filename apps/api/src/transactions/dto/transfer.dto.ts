import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { IsMinorUnitAmount } from '../../common/decorators/minor-unit-amount.decorator';
import { Transform } from 'class-transformer';

export class TransferFundsDto {
  @IsUUID()
  sourceWalletId!: string;

  @IsUUID()
  destinationWalletId!: string;

  // Custom decorator shared between deposit and transfer DTOs
  @IsMinorUnitAmount()
  amount!: string;

  // Optional note. It is trimmed, and a blank one counts as "not sent".
  @IsOptional()
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsString()
  @MaxLength(200)
  description?: string;
}
