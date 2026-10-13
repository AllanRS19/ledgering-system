import { IsUUID, Matches } from 'class-validator';

export class DepositFundsDto {
  @IsUUID()
  walletId!: string;

  // A string of digits (JSON numbers lose precision): positive, no leading
  // zero, at most 12 digits. That is always below MAX_POSTING_AMOUNT, and
  // BigInt() can never throw on it.
  @Matches(/^[1-9]\d{0,11}$/, {
    message:
      'amount must be a positive whole number of minor units (cents), sent as a string',
  })
  amount!: string;
}
