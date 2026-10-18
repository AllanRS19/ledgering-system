/**
 * What clients are told about ledger failures. One source, so a failure that
 * is replayed later (same Idempotency-Key) reads exactly like the original.
 */
export const INSUFFICIENT_FUNDS_MESSAGE =
  'Insufficient funds for this operation';
