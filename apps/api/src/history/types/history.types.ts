import type { LedgerDirection } from '../../ledger/types/ledger.types';

/** From the caller's point of view: money in, or money out. */
export type HistoryDirection = 'IN' | 'OUT';

/**
 * A transaction as the history query loads it. `entries` holds ONLY the
 * caller's own entries: the query filters them, so the other side of a
 * transfer is never loaded.
 */
export interface HistoryTransactionRow {
  id: string;
  type: string;
  status: string;
  amount: bigint;
  currency: string;
  description: string | null;
  failureReason: string | null;
  sourceWalletId: string | null;
  createdAt: Date;
  entries: {
    walletId: string;
    direction: LedgerDirection;
    balanceAfter: bigint;
    wallet: { userId: string | null };
  }[];
}

/** One line of "my transactions". */
export interface TransactionHistoryItem {
  id: string;
  type: string;
  status: string;
  direction: HistoryDirection;
  amount: bigint;
  currency: string;
  walletId: string | null;
  balanceAfter: bigint | null;
  description: string | null;
  failureReason: string | null;
  createdAt: Date;
}

/** A ledger entry as the statement query loads it. */
export interface HistoryEntryRow {
  id: string;
  direction: LedgerDirection;
  amount: bigint;
  balanceAfter: bigint;
  postedAt: Date;
  transaction: {
    id: string;
    type: string;
    status: string;
    description: string | null;
  };
}

/** One line of a wallet statement. */
export interface EntryHistoryItem {
  id: string;
  direction: HistoryDirection;
  amount: bigint;
  balanceAfter: bigint;
  postedAt: Date;
  transaction: {
    id: string;
    type: string;
    status: string;
    description: string | null;
  };
}

/** What both endpoints return. `nextCursor` is null on the last page. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
