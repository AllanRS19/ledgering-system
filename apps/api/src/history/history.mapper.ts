import type { LedgerDirection } from '../ledger/types/ledger.types';
import type {
  EntryHistoryItem,
  HistoryDirection,
  HistoryEntryRow,
  HistoryTransactionRow,
  TransactionHistoryItem,
} from './types/history.types';

const toHistoryDirection = (direction: LedgerDirection): HistoryDirection =>
  direction === 'CREDIT' ? 'IN' : 'OUT';

/**
 * Turns a transaction row into what the CALLER should see.
 *
 * The row must carry only the caller's own entries. The check below makes
 * sure of it, so a mistake in the query cannot silently expose someone
 * else's wallet or balance.
 *
 * Fields are copied one by one, never spread: whatever the row has beyond
 * these fields (initiatedById, the other party's wallets...) stays out.
 *
 * Anything that "cannot happen" throws a plain Error: Nest logs it and
 * answers with a generic 500, instead of the mapper guessing.
 */
export function toTransactionItem(
  row: HistoryTransactionRow,
  userId: string,
): TransactionHistoryItem {
  if (row.entries.some((entry) => entry.wallet.userId !== userId)) {
    throw new Error(
      `Transaction ${row.id} was loaded with an entry that belongs to someone else`,
    );
  }

  // A failed transfer has no ledger entries: only the one who asked for it
  // can see it, as money that did not leave.
  if (row.status === 'FAILED') {
    if (row.entries.length > 0) {
      throw new Error(`Failed transaction ${row.id} has ledger entries`);
    }

    return {
      id: row.id,
      type: row.type,
      status: row.status,
      direction: 'OUT',
      amount: row.amount,
      currency: row.currency,
      walletId: row.sourceWalletId,
      balanceAfter: null,
      description: row.description,
      failureReason: row.failureReason,
      createdAt: row.createdAt,
    };
  }

  if (row.status !== 'COMPLETED') {
    throw new Error(
      `Transaction ${row.id} has status ${row.status}, expected COMPLETED or FAILED`,
    );
  }

  // One wallet per currency per user, and a transaction involves one
  // currency, so the caller has exactly one entry in a completed transaction.
  if (row.entries.length !== 1) {
    throw new Error(
      `Transaction ${row.id} should have exactly one entry of the caller, found ${row.entries.length}`,
    );
  }

  const [entry] = row.entries;

  return {
    id: row.id,
    type: row.type,
    status: row.status,
    direction: toHistoryDirection(entry.direction),
    amount: row.amount,
    currency: row.currency,
    walletId: entry.walletId,
    balanceAfter: entry.balanceAfter,
    description: row.description,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
  };
}

/**
 * Turns a ledger entry into a statement line. Whose wallet it is was already
 * checked before the query, so there is no per-user logic here.
 */
export function toEntryItem(entry: HistoryEntryRow): EntryHistoryItem {
  return {
    id: entry.id,
    direction: toHistoryDirection(entry.direction),
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    postedAt: entry.postedAt,
    transaction: {
      id: entry.transaction.id,
      type: entry.transaction.type,
      status: entry.transaction.status,
      description: entry.transaction.description,
    },
  };
}
