import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { SUPPORTED_CURRENCIES } from '../../common/constants';
import { Transform } from 'class-transformer';
import type { SupportedCurrency } from '../types/wallets.types';

export class CreateWalletDto {
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @IsNotEmpty()
  @IsIn(SUPPORTED_CURRENCIES)
  currency!: SupportedCurrency;
}
