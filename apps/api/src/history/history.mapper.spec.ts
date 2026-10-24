import { toEntryItem, toTransactionItem } from './history.mapper';
import type {
  HistoryEntryRow,
  HistoryTransactionRow,
} from './types/history.types';

const NOW = new Date('2026-01-01T00:00:00.000Z');

type OwnEntry = HistoryTransactionRow['entries'][number];

/** A transaction row, with the fields the tests care about overridable. */
const row = (
  overrides: Partial<HistoryTransactionRow> = {},
): HistoryTransactionRow => ({
  id: 'tx-1',
  type: 'TRANSFER',
  status: 'COMPLETED',
  amount: 3000n,
  currency: 'USD',
  description: 'rent',
  failureReason: null,
  sourceWalletId: 'wallet-alice',
  createdAt: NOW,
  entries: [],
  ...overrides,
});

/** An entry on one of the CALLER's wallets. */
const entry = (
  userId: string,
  overrides: Partial<OwnEntry> = {},
): OwnEntry => ({
  walletId: 'wallet-alice',
  direction: 'DEBIT',
  balanceAfter: 7000n,
  wallet: { userId },
  ...overrides,
});

const EXPECTED_TRANSACTION_KEYS = [
  'amount',
  'balanceAfter',
  'createdAt',
  'currency',
  'description',
  'direction',
  'failureReason',
  'id',
  'status',
  'type',
  'walletId',
];

describe('toTransactionItem', () => {
  it('shows a transfer the caller SENT as money out, with their own balance', () => {
    const item = toTransactionItem(row({ entries: [entry('alice')] }), 'alice');

    expect(item).toEqual({
      id: 'tx-1',
      type: 'TRANSFER',
      status: 'COMPLETED',
      direction: 'OUT',
      amount: 3000n,
      currency: 'USD',
      walletId: 'wallet-alice',
      balanceAfter: 7000n,
      description: 'rent',
      failureReason: null,
      createdAt: NOW,
    });
  });

  it('shows the same transfer to the RECIPIENT as money in, with their own wallet and balance', () => {
    const received = entry('bob', {
      walletId: 'wallet-bob',
      direction: 'CREDIT',
      balanceAfter: 8000n,
    });

    const item = toTransactionItem(row({ entries: [received] }), 'bob');

    expect(item.direction).toBe('IN');
    expect(item.walletId).toBe('wallet-bob');
    expect(item.balanceAfter).toBe(8000n);
  });

  it('shows a deposit as money in', () => {
    const item = toTransactionItem(
      row({
        type: 'DEPOSIT',
        description: null,
        sourceWalletId: null,
        entries: [entry('alice', { direction: 'CREDIT', balanceAfter: 5000n })],
      }),
      'alice',
    );

    expect(item.direction).toBe('IN');
    expect(item.balanceAfter).toBe(5000n);
  });

  it('shows a failed transfer as money that did not leave, with no balance', () => {
    const item = toTransactionItem(
      row({
        status: 'FAILED',
        failureReason: 'INSUFFICIENT_FUNDS',
        entries: [],
      }),
      'alice',
    );

    expect(item).toMatchObject({
      status: 'FAILED',
      direction: 'OUT',
      walletId: 'wallet-alice',
      balanceAfter: null,
      failureReason: 'INSUFFICIENT_FUNDS',
    });
  });

  it('shows a failed transfer from before wallet ids were stored, without a wallet', () => {
    const item = toTransactionItem(
      row({
        status: 'FAILED',
        failureReason: 'INSUFFICIENT_FUNDS',
        sourceWalletId: null,
        entries: [],
      }),
      'alice',
    );

    expect(item.walletId).toBeNull();
    expect(item.balanceAfter).toBeNull();
  });

  describe('what the caller is never shown', () => {
    it('contains exactly the documented fields, for a completed transaction', () => {
      const item = toTransactionItem(
        row({ entries: [entry('alice')] }),
        'alice',
      );

      expect(Object.keys(item).sort()).toEqual(EXPECTED_TRANSACTION_KEYS);
    });

    it('contains exactly the documented fields, for a failed one', () => {
      const item = toTransactionItem(
        row({ status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS' }),
        'alice',
      );

      expect(Object.keys(item).sort()).toEqual(EXPECTED_TRANSACTION_KEYS);
    });

    it('drops fields that identify the other side, even if the row carries them', () => {
      const dirtyRow = {
        ...row({ entries: [entry('bob', { direction: 'CREDIT' })] }),
        initiatedById: 'alice',
        destinationWalletId: 'wallet-bob',
        requestHash: 'abc',
      } as HistoryTransactionRow;

      const item = toTransactionItem(dirtyRow, 'bob');

      expect(item).not.toHaveProperty('initiatedById');
      expect(item).not.toHaveProperty('destinationWalletId');
      expect(item).not.toHaveProperty('sourceWalletId');
      expect(item).not.toHaveProperty('requestHash');
    });
  });

  describe('data that should be impossible', () => {
    it("refuses an entry that belongs to someone else's wallet", () => {
      expect(() =>
        toTransactionItem(
          row({ entries: [entry('alice'), entry('bob')] }),
          'alice',
        ),
      ).toThrow('belongs to someone else');
    });

    it('refuses a completed transaction with no entry of the caller', () => {
      expect(() => toTransactionItem(row({ entries: [] }), 'alice')).toThrow(
        'exactly one entry',
      );
    });

    it('refuses a completed transaction with two entries of the caller', () => {
      expect(() =>
        toTransactionItem(
          row({ entries: [entry('alice'), entry('alice')] }),
          'alice',
        ),
      ).toThrow('exactly one entry');
    });

    it('refuses a failed transaction that has entries', () => {
      expect(() =>
        toTransactionItem(
          row({ status: 'FAILED', entries: [entry('alice')] }),
          'alice',
        ),
      ).toThrow('has ledger entries');
    });

    it.each(['PENDING', 'SOMETHING_ELSE'])(
      'refuses the status %s',
      (status) => {
        expect(() =>
          toTransactionItem(
            row({ status, entries: [entry('alice')] }),
            'alice',
          ),
        ).toThrow(`has status ${status}`);
      },
    );
  });
});

describe('toEntryItem', () => {
  const entryRow = (
    overrides: Partial<HistoryEntryRow> = {},
  ): HistoryEntryRow => ({
    id: 'entry-1',
    direction: 'DEBIT',
    amount: 3000n,
    balanceAfter: 7000n,
    postedAt: NOW,
    transaction: {
      id: 'tx-1',
      type: 'TRANSFER',
      status: 'COMPLETED',
      description: 'rent',
    },
    ...overrides,
  });

  it('turns a DEBIT into money out and a CREDIT into money in', () => {
    expect(toEntryItem(entryRow({ direction: 'DEBIT' })).direction).toBe('OUT');
    expect(toEntryItem(entryRow({ direction: 'CREDIT' })).direction).toBe('IN');
  });

  it('keeps the amount, the balance after, and the time it was posted', () => {
    expect(toEntryItem(entryRow())).toEqual({
      id: 'entry-1',
      direction: 'OUT',
      amount: 3000n,
      balanceAfter: 7000n,
      postedAt: NOW,
      transaction: {
        id: 'tx-1',
        type: 'TRANSFER',
        status: 'COMPLETED',
        description: 'rent',
      },
    });
  });

  it('contains exactly the documented fields, and nothing else from the row', () => {
    const dirty = {
      ...entryRow(),
      walletId: 'wallet-alice',
      transactionId: 'tx-1',
    } as HistoryEntryRow;

    const item = toEntryItem(dirty);

    expect(Object.keys(item).sort()).toEqual([
      'amount',
      'balanceAfter',
      'direction',
      'id',
      'postedAt',
      'transaction',
    ]);
    expect(Object.keys(item.transaction).sort()).toEqual([
      'description',
      'id',
      'status',
      'type',
    ]);
  });
});
