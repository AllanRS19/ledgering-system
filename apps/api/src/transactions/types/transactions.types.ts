import { InsufficientFundsError } from '../../ledger/ledger.errors';

export interface DepositFundsPayload {
  userId: string;
  walletId: string;
  amount: bigint;
  idempotencyKey: string;
}

export interface TransferFundsPayload {
  userId: string;
  sourceWalletId: string;
  destinationWalletId: string;
  amount: bigint;
  description?: string;
  idempotencyKey: string;
}

/**
 * What the API returns for a deposit: the user's side only. The funding
 * wallet is internal and never appears here. In JSON, the bigint fields
 * (amount, balanceAfter) are sent as strings.
 */
export interface DepositResult {
  id: string;
  type: string;
  status: string;
  amount: bigint;
  currency: string;
  walletId: string;
  balanceAfter: bigint;
  createdAt: Date;
}

/**
 * What the API returns for a transfer: the sender's side only. The
 * recipient's balance and owner are never exposed.
 */
export interface TransferResult {
  id: string;
  type: string;
  status: string;
  amount: bigint;
  currency: string;
  sourceWalletId: string;
  destinationWalletId: string;
  description: string | null;
  balanceAfter: bigint;
  createdAt: Date;
}

/**
 * What the database transaction hands back. A failed transfer is returned,
 * not thrown, so the FAILED row commits. It is rethrown afterwards.
 */
export type TransferOutcome =
  | { kind: 'completed'; result: TransferResult }
  | { kind: 'failed'; error: InsufficientFundsError };

/**
 * What the service hands to the controller: the result, and whether it is the
 * replay of an earlier identical request (the controller marks those with a
 * response header).
 */
export interface IdempotentResult<T> {
  result: T;
  replayed: boolean;
}

/** A transaction found by its Idempotency-Key: only the fields a replay needs. */
export interface StoredTransaction {
  id: string;
  type: string;
  status: string;
  amount: bigint;
  currency: string;
  description: string | null;
  failureReason: string | null;
  requestHash: string;
  createdAt: Date;
  entries: { walletId: string; balanceAfter: bigint }[];
}
