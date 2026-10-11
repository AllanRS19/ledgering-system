import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidPostingError,
  LedgerError,
  UnbalancedPostingError,
  WalletNotFoundError,
} from './ledger.errors';

describe('ledger errors', () => {
  const cases: Array<[string, LedgerError, string]> = [
    ['InvalidPostingError', new InvalidPostingError('x'), 'INVALID_POSTING'],
    [
      'UnbalancedPostingError',
      new UnbalancedPostingError(2n, 1n),
      'UNBALANCED_POSTING',
    ],
    ['WalletNotFoundError', new WalletNotFoundError('w1'), 'WALLET_NOT_FOUND'],
    [
      'CurrencyMismatchError',
      new CurrencyMismatchError('w1', 'EUR', 'USD'),
      'CURRENCY_MISMATCH',
    ],
    [
      'InsufficientFundsError',
      new InsufficientFundsError('w1', 1n, 2n),
      'INSUFFICIENT_FUNDS',
    ],
  ];

  it.each(cases)(
    '%s is a LedgerError with the right name and code',
    (name, error, code) => {
      expect(error).toBeInstanceOf(LedgerError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(name);
      expect(error.code).toBe(code);
    },
  );
});
