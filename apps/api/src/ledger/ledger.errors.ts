export abstract class LedgerError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);

    this.name = new.target.name;
  }
}

/** The request is malformed: too few lines, a bad amount, a repeated wallet... */
export class InvalidPostingError extends LedgerError {
  readonly code = 'INVALID_POSTING';

  constructor(reason: string) {
    super(`Invalid posting: ${reason}`);
  }
}

export class UnbalancedPostingError extends LedgerError {
  readonly code = 'UNBALANCED_POSTING';

  constructor(
    readonly totalDebits: bigint,
    readonly totalCredits: bigint,
  ) {
    super(`Debits (${totalDebits}) do not equal credits (${totalCredits})`);
  }
}

export class WalletNotFoundError extends LedgerError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} was not found`);
  }
}

export class CurrencyMismatchError extends LedgerError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly walletId: string,
    readonly walletCurrency: string,
    readonly postingCurrency: string,
  ) {
    super(
      `Wallet ${walletId} holds ${walletCurrency}, but the posting is in ${postingCurrency}`,
    );
  }
}

export class InsufficientFundsError extends LedgerError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(
    readonly walletId: string,
    readonly balance: bigint,
    readonly required: bigint,
  ) {
    super(`Wallet ${walletId} has ${balance} but ${required} is required`);
  }
}
