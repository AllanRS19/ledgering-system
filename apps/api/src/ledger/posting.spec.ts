import { MAX_POSTING_AMOUNT } from '../common/constants';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidPostingError,
  UnbalancedPostingError,
  WalletNotFoundError,
} from './ledger.errors';
import { assertValidLines, planPosting } from './posting';
import { PostingLine, WalletState } from './types/ledger.types';

// Small builders so each test reads like a sentence
const debit = (walletId: string, amount: bigint): PostingLine => ({
  walletId,
  direction: 'DEBIT',
  amount,
});

const credit = (walletId: string, amount: bigint): PostingLine => ({
  walletId,
  direction: 'CREDIT',
  amount,
});

const wallet = (
  id: string,
  balance: bigint,
  overrides: Partial<WalletState> = {},
): WalletState => ({
  id,
  currency: 'USD',
  balance,
  isSystem: false,
  ...overrides,
});

describe('assertValidLines', () => {
  it('accepts a balanced transfer', () => {
    expect(() =>
      assertValidLines([debit('alice', 3000n), credit('bob', 3000n)]),
    ).not.toThrow();
  });

  it('accepts three balanced lines (transfer plus a fee)', () => {
    expect(() =>
      assertValidLines([
        debit('alice', 3100n),
        credit('bob', 3000n),
        credit('fees', 100n),
      ]),
    ).not.toThrow();
  });

  it('accepts an amount exactly at the maximum', () => {
    expect(() =>
      assertValidLines([
        debit('alice', MAX_POSTING_AMOUNT),
        credit('bob', MAX_POSTING_AMOUNT),
      ]),
    ).not.toThrow();
  });

  it('rejects an empty list of lines', () => {
    expect(() => assertValidLines([])).toThrow(InvalidPostingError);
  });

  it('rejects a single line', () => {
    expect(() => assertValidLines([debit('alice', 3000n)])).toThrow(
      InvalidPostingError,
    );
  });

  it.each([0n, -500n, MAX_POSTING_AMOUNT + 1n])(
    'rejects the amount %p',
    (amount) => {
      expect(() =>
        assertValidLines([debit('alice', amount), credit('bob', amount)]),
      ).toThrow(InvalidPostingError);
    },
  );

  it('rejects an amount that is not a bigint', () => {
    const notBigint = {
      walletId: 'alice',
      direction: 'DEBIT',
      amount: 5,
    } as unknown as PostingLine;

    expect(() => assertValidLines([notBigint, credit('bob', 5n)])).toThrow(
      InvalidPostingError,
    );
  });

  it('rejects an unknown direction', () => {
    const sideways = {
      walletId: 'alice',
      direction: 'SIDEWAYS',
      amount: 100n,
    } as unknown as PostingLine;

    expect(() => assertValidLines([sideways, credit('bob', 100n)])).toThrow(
      InvalidPostingError,
    );
  });

  it('rejects a line without a wallet id', () => {
    expect(() =>
      assertValidLines([debit('', 100n), credit('bob', 100n)]),
    ).toThrow(InvalidPostingError);
  });

  it('rejects the same wallet appearing twice, even if the totals balance', () => {
    expect(() =>
      assertValidLines([debit('alice', 100n), credit('alice', 100n)]),
    ).toThrow(InvalidPostingError);
  });

  it('rejects debits that do not equal credits', () => {
    expect(() =>
      assertValidLines([debit('alice', 3000n), credit('bob', 2900n)]),
    ).toThrow(UnbalancedPostingError);
  });
});

describe('planPosting', () => {
  it('plans a transfer with the right entries and balances', () => {
    const plan = planPosting(
      'USD',
      [debit('alice', 3000n), credit('bob', 3000n)],
      [wallet('alice', 10000n), wallet('bob', 5000n)],
    );

    expect(plan.entries).toEqual([
      {
        walletId: 'alice',
        direction: 'DEBIT',
        amount: 3000n,
        balanceAfter: 7000n,
      },
      {
        walletId: 'bob',
        direction: 'CREDIT',
        amount: 3000n,
        balanceAfter: 8000n,
      },
    ]);
    expect(plan.newBalances.get('alice')).toBe(7000n);
    expect(plan.newBalances.get('bob')).toBe(8000n);
  });

  it('lets a funding wallet go negative on a deposit', () => {
    const plan = planPosting(
      'USD',
      [debit('funding', 5000n), credit('alice', 5000n)],
      [wallet('funding', 0n, { isSystem: true }), wallet('alice', 0n)],
    );

    expect(plan.newBalances.get('funding')).toBe(-5000n);
    expect(plan.newBalances.get('alice')).toBe(5000n);
  });

  it('allows a user wallet to end at exactly zero', () => {
    const plan = planPosting(
      'USD',
      [debit('alice', 3000n), credit('bob', 3000n)],
      [wallet('alice', 3000n), wallet('bob', 0n)],
    );

    expect(plan.newBalances.get('alice')).toBe(0n);
  });

  it('refuses a user wallet that would end below zero', () => {
    expect(() =>
      planPosting(
        'USD',
        [debit('alice', 3000n), credit('bob', 3000n)],
        [wallet('alice', 2999n), wallet('bob', 0n)],
      ),
    ).toThrow(InsufficientFundsError);
  });

  it('plans three lines (transfer plus a fee wallet)', () => {
    const plan = planPosting(
      'USD',
      [debit('alice', 3100n), credit('bob', 3000n), credit('fees', 100n)],
      [
        wallet('alice', 10000n),
        wallet('bob', 0n),
        wallet('fees', 0n, { isSystem: true }),
      ],
    );

    expect(plan.entries.map((e) => e.balanceAfter)).toEqual([
      6900n,
      3000n,
      100n,
    ]);
  });

  it('throws when a wallet is missing from the wallet list', () => {
    expect(() =>
      planPosting(
        'USD',
        [debit('alice', 3000n), credit('bob', 3000n)],
        [wallet('alice', 10000n)],
      ),
    ).toThrow(WalletNotFoundError);
  });

  it('throws when a wallet holds another currency', () => {
    expect(() =>
      planPosting(
        'USD',
        [debit('alice', 3000n), credit('bob', 3000n)],
        [wallet('alice', 10000n), wallet('bob', 0n, { currency: 'EUR' })],
      ),
    ).toThrow(CurrencyMismatchError);
  });

  it('validates the lines itself, even when the caller skipped the check', () => {
    expect(() =>
      planPosting(
        'USD',
        [debit('alice', 3000n), credit('bob', 2900n)],
        [wallet('alice', 10000n), wallet('bob', 0n)],
      ),
    ).toThrow(UnbalancedPostingError);
  });

  it('conserves money: the balance changes add up to zero', () => {
    const wallets = [wallet('alice', 10000n), wallet('bob', 5000n)];

    const plan = planPosting(
      'USD',
      [debit('alice', 3000n), credit('bob', 3000n)],
      wallets,
    );

    const totalChange = wallets.reduce(
      (sum, w) => sum + ((plan.newBalances.get(w.id) ?? w.balance) - w.balance),
      0n,
    );
    expect(totalChange).toBe(0n);
  });

  it('never changes the wallets or lines it is given', () => {
    const lines = [debit('alice', 3000n), credit('bob', 3000n)];
    const wallets = [wallet('alice', 10000n), wallet('bob', 5000n)];
    const linesBefore = lines.map((line) => ({ ...line }));
    const walletsBefore = wallets.map((w) => ({ ...w }));

    planPosting('USD', lines, wallets);

    expect(lines).toEqual(linesBefore);
    expect(wallets).toEqual(walletsBefore);
  });
});
