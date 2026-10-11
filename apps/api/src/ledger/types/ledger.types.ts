/** DEBIT lowers a wallet's balance, CREDIT raises it. */
export type LedgerDirection = 'DEBIT' | 'CREDIT';

/** One side of a movement: this wallet goes down (or up) by this much. */
export interface PostingLine {
  walletId: string;
  direction: LedgerDirection;
  /** Minor units (cents). Must be a positive integer. */
  amount: bigint;
}

/** What a caller (deposit, transfer...) hands to the ledger. */
export interface PostingRequest {
  transactionId: string;
  currency: string;
  lines: PostingLine[];
}

/** A wallet as the ledger sees it AFTER locking: numbers it can trust. */
export interface WalletState {
  id: string;
  currency: string;
  balance: bigint;
  isSystem: boolean;
}

/** One entry the ledger is about to write. */
export interface PlannedEntry {
  walletId: string;
  direction: LedgerDirection;
  amount: bigint;
  balanceAfter: bigint;
}

/** The result of the pure step: what to write, nothing written yet. */
export interface PostingPlan {
  entries: PlannedEntry[];
  newBalances: Map<string, bigint>;
}
