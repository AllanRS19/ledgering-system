import { createHash } from 'node:crypto';
/**
 * The parts of the request that decide whether two calls that share an
 * Idempotency-Key are "the same request". The user is not here: keys are
 * already scoped per user
 */

export type HashableRequest =
  | { type: 'DEPOSIT'; walletId: string; amount: bigint }
  | {
      type: 'TRANSFER';
      sourceWalletId: string;
      destinationWalletId: string;
      amount: bigint;
      description?: string | null;
    };

/**
 * A SHA-256 fingerprint of a request, stored with the transaction. A retry
 * must produce the same fingerprint, and any real change must produce a
 * different one.
 *
 * Canonical on purpose: fields in a fixed order, the amount as plain digits,
 * a missing description the same as an empty one. Encoded as a JSON array of
 * strings, so no two different requests can collapse into one string
 * (with a separator like "|", the ids "ab"+"c" and "a"+"bc" could collide).
 */
export function hashRequest(request: HashableRequest): string {
  const cannonical =
    request.type === 'DEPOSIT'
      ? [request.type, request.walletId, request.amount.toString()]
      : [
          request.type,
          request.sourceWalletId,
          request.destinationWalletId,
          request.amount.toString(),
          (request.description ?? '').trim(),
        ];

  return createHash('sha256').update(JSON.stringify(cannonical)).digest('hex');
}
