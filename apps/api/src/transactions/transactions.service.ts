import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from '../common/helpers';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
} from '../ledger/ledger.errors';
import { PlannedEntry } from '../ledger/types/ledger.types';
import type {
  DepositFundsPayload,
  DepositResult,
  IdempotentResult,
  StoredTransaction,
  TransferFundsPayload,
  TransferOutcome,
  TransferResult,
} from './types/transactions.types';
import { hashRequest } from './request-hash';
import { IdempotencyKeyReusedException } from './idempotency-key-reused.exception';
import { InsufficientFundsReplayException } from './insufficient-funds-replay.exception';

/**
 * Idempotency, in short. A transaction row is the record of an attempt:
 *
 * - The unique rule on (initiatedById, idempotencyKey) means a key can only
 *   ever belong to one row per user. Rows are permanent, so a key is never
 *   forgotten.
 * - requestHash says WHICH request the key belongs to. The same key with a
 *   different request is rejected, not replayed.
 * - Only outcomes that created a row are remembered: COMPLETED and FAILED.
 *   Rejections before that point (404, same wallet, currency mismatch) store
 *   nothing, so the key stays free and the client can fix the request and
 *   reuse it.
 */
@Injectable()
export class TransactionsService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly prisma: PrismaService,
  ) {}

  async depositFunds(
    payload: DepositFundsPayload,
  ): Promise<IdempotentResult<DepositResult>> {
    const { userId, walletId, amount, idempotencyKey } = payload;
    const requestHash = hashRequest({ type: 'DEPOSIT', walletId, amount });

    // Fast path: a retry of a request that already finished
    const existing = await this.findStoredTransaction(userId, idempotencyKey);
    if (existing) {
      return this.replayDeposit(existing, requestHash, walletId);
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // Filtering by userId makes someone else's wallet, a system wallet
        // and a wallet that does not exist look exactly the same
        const userWallet = await tx.wallet.findFirst({
          where: { id: walletId, userId },
        });

        if (!userWallet) {
          throw new NotFoundException(`Wallet was not found`);
        }

        // The currency always comes from the wallet, never from the client
        const { currency } = userWallet;

        const fundingWallet = await tx.wallet.findFirst({
          where: { currency, isSystem: true },
        });

        if (!fundingWallet) {
          // A plain Error, not an HttpException: Nest logs unknown errors
          // with their stack and answers with a generic 500.
          throw new Error(
            `No funding wallet for ${currency}, but a user wallet exists in that currency`,
          );
        }

        // Created first: the unique (user, idempotency key) rule rejects a
        // duplicate before any money moves. COMPLETED from the start is safe
        // because any failure below rolls this row back.
        const transaction = await tx.transaction.create({
          data: {
            type: 'DEPOSIT',
            status: 'COMPLETED',
            amount,
            currency,
            idempotencyKey,
            requestHash,
            initiatedById: userId,
          },
        });

        const entries = await this.ledgerService.post(tx, {
          transactionId: transaction.id,
          currency,
          lines: [
            { walletId: fundingWallet.id, direction: 'DEBIT', amount },
            { walletId: userWallet.id, direction: 'CREDIT', amount },
          ],
        });

        const userEntry = entries.find(
          (entry) => entry.walletId === userWallet.id,
        );

        if (!userEntry) {
          throw new Error(
            `The ledger returned no entry for wallet ${userWallet.id}`,
          );
        }

        return {
          id: transaction.id,
          type: transaction.type,
          status: transaction.status,
          amount: transaction.amount,
          currency: transaction.currency,
          walletId: userWallet.id,
          balanceAfter: userEntry.balanceAfter,
          createdAt: transaction.createdAt,
        };
      });

      return { result, replayed: false };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // Another request with this key committed first. This runs after the
      // $transaction call has ended, because Postgres marks a transaction as
      // aborted after an error and would refuse any further query inside it.
      const winner = await this.findStoredTransaction(userId, idempotencyKey);
      if (!winner) {
        throw error;
      }

      return this.replayDeposit(winner, requestHash, walletId);
    }
  }

  async transferFunds(
    payload: TransferFundsPayload,
  ): Promise<IdempotentResult<TransferResult>> {
    const {
      userId,
      sourceWalletId,
      destinationWalletId,
      amount,
      description,
      idempotencyKey,
    } = payload;

    // Needs no database: a wallet cannot send to itself
    if (sourceWalletId === destinationWalletId) {
      throw new UnprocessableEntityException(
        'You cannot transfer to the same wallet',
      );
    }

    const requestHash = hashRequest({
      type: 'TRANSFER',
      sourceWalletId,
      destinationWalletId,
      amount,
      description,
    });

    // Fast path: a retry of a request that already finished (or failed).
    const existing = await this.findStoredTransaction(userId, idempotencyKey);
    if (existing) {
      return this.replayTransfer(
        existing,
        requestHash,
        sourceWalletId,
        destinationWalletId,
      );
    }

    let outcome: TransferOutcome;

    try {
      outcome = await this.prisma.$transaction(
        async (tx): Promise<TransferOutcome> => {
          // Both wallets in one round trip. Only fields that never change
          // are read: balances are left to the ledger, which reads them
          // after locking. isSystem: false means a funding wallet used as
          // source or destination is simply "not found".
          const wallets = await tx.wallet.findMany({
            where: {
              id: { in: [sourceWalletId, destinationWalletId] },
              isSystem: false,
            },
            select: {
              id: true,
              userId: true,
              currency: true,
            },
          });

          // 1. Locate the specifics wallets strictly by ID
          const sourceWallet = wallets.find(
            (wallet) => wallet.id === sourceWalletId,
          );
          const destinationWallet = wallets.find(
            (wallet) => wallet.id === destinationWalletId,
          );

          // Someone else's source wallet looks exactly like a missing one.
          if (!sourceWallet || sourceWallet.userId !== userId) {
            throw new NotFoundException('Source wallet was not found');
          }

          // 2. Validate destination wallet existence
          if (!destinationWallet) {
            throw new NotFoundException('Destination wallet was not found');
          }

          // Same error class (and so the same response shape) as when the
          // ledger detects it: the filter turns it into a 422.
          if (sourceWallet.currency !== destinationWallet.currency) {
            throw new CurrencyMismatchError(
              destinationWallet.id,
              destinationWallet.currency,
              sourceWallet.currency,
            );
          }

          // The currency always comes from the source wallet.
          const { currency } = sourceWallet;

          // PENDING while the ledger works. Created first, so the unique
          // (user, idempotency key) rule rejects a duplicate before any
          // money moves.
          const transaction = await tx.transaction.create({
            data: {
              type: 'TRANSFER',
              status: 'PENDING',
              amount,
              currency,
              description,
              idempotencyKey,
              requestHash,
              initiatedById: userId,
            },
          });

          let entries: PlannedEntry[];

          try {
            entries = await this.ledgerService.post(tx, {
              transactionId: transaction.id,
              currency,
              lines: [
                { walletId: sourceWallet.id, direction: 'DEBIT', amount },
                { walletId: destinationWallet.id, direction: 'CREDIT', amount },
              ],
            });
          } catch (error) {
            // The one error caught inside the transaction. It is safe
            // because the ledger throws it from its planning step, BEFORE
            // writing anything, and it is not a database error, so the
            // transaction is still usable. Anything else propagates and
            // rolls everything back.
            if (error instanceof InsufficientFundsError) {
              await tx.transaction.update({
                where: { id: transaction.id },
                // The code, not the message: the message has wallet ids
                // and balances in it
                data: {
                  status: 'FAILED',
                  failureReason: error.code,
                },
              });

              // Returned, not thrown: returning commits the FAILED row
              return { kind: 'failed', error };
            }
            throw error;
          }

          const sourceEntry = entries.find(
            (entry) => entry.walletId === sourceWallet.id,
          );

          if (!sourceEntry) {
            throw new Error(
              `The ledger returned no entry for wallet ${sourceWallet.id}`,
            );
          }

          const completed = await tx.transaction.update({
            where: { id: transaction.id },
            data: { status: 'COMPLETED' },
          });

          return {
            kind: 'completed',
            result: {
              id: completed.id,
              type: completed.type,
              status: completed.status,
              amount: completed.amount,
              currency: completed.currency,
              sourceWalletId: sourceWallet.id,
              destinationWalletId: destinationWallet.id,
              description: completed.description,
              balanceAfter: sourceEntry.balanceAfter,
              createdAt: completed.createdAt,
            },
          };
        },
      );
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // Another request with this key committed first: see depositFunds.
      const winner = await this.findStoredTransaction(userId, idempotencyKey);
      if (!winner) {
        throw error;
      }

      return this.replayTransfer(
        winner,
        requestHash,
        sourceWalletId,
        destinationWalletId,
      );
    }

    // The FAILED row is committed by now. Rethrowing lets the exception
    // filter answer 422 INSUFFICIENT_FUNDS.
    if (outcome.kind === 'failed') {
      throw outcome.error;
    }

    return { result: outcome.result, replayed: false };
  }

  /**
   * The transaction this user already created with this key, if any. Always
   * scoped to the user, so nobody can replay someone else's transaction.
   * Runs outside any database transaction.
   */
  private findStoredTransaction(
    userId: string,
    idempotencyKey: string,
  ): Promise<StoredTransaction | null> {
    return this.prisma.transaction.findUnique({
      where: {
        initiatedById_idempotencyKey: { initiatedById: userId, idempotencyKey },
      },
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        currency: true,
        description: true,
        failureReason: true,
        requestHash: true,
        createdAt: true,
        entries: { select: { walletId: true, balanceAfter: true } },
      },
    });
  }

  /** Same key, different request: a client bug, never a replay. */
  private assertSameRequest(
    stored: StoredTransaction,
    requestHash: string,
  ): void {
    if (stored.requestHash !== requestHash) {
      throw new IdempotencyKeyReusedException();
    }
  }

  /**
   * Rebuilds the answer to a deposit that already happened, from the stored
   * rows. The wallet id comes from the request: an equal fingerprint proves
   * it is the same wallet as the original. balanceAfter is the balance back
   * then, not the current one.
   */
  private replayDeposit(
    stored: StoredTransaction,
    requestHash: string,
    walletId: string,
  ): IdempotentResult<DepositResult> {
    this.assertSameRequest(stored, requestHash);

    // Deposits are created COMPLETED inside a transaction that rolls back on
    // any failure, so anything else here means the data is wrong.
    if (stored.status !== 'COMPLETED') {
      throw new Error(
        `Deposit ${stored.id} was found with status ${stored.status}, expected COMPLETED`,
      );
    }

    const entry = stored.entries.find((item) => item.walletId === walletId);
    if (!entry) {
      throw new Error(
        `Deposit ${stored.id} has no longer entry for its wallet`,
      );
    }

    return {
      replayed: true,
      result: {
        id: stored.id,
        type: stored.type,
        status: stored.status,
        amount: stored.amount,
        currency: stored.currency,
        walletId,
        balanceAfter: entry.balanceAfter,
        createdAt: stored.createdAt,
      },
    };
  }

  /**
   * Rebuilds the answer to a transfer that already happened or failed, from
   * the stored rows. A FAILED transfer has no ledger entries, which is why
   * the request fingerprint is stored on the transaction itself.
   */
  private replayTransfer(
    stored: StoredTransaction,
    requestHash: string,
    sourceWalletId: string,
    destinationWalletId: string,
  ): IdempotentResult<TransferResult> {
    this.assertSameRequest(stored, requestHash);

    if (stored.status === 'FAILED') {
      if (stored.failureReason === 'INSUFFICIENT_FUNDS') {
        throw new InsufficientFundsReplayException();
      }

      throw new Error(
        `Transfer ${stored.id} failed for an unknown reason: ${String(stored.failureReason)}`,
      );
    }

    // A PENDING row is only ever visible inside the transaction that created
    // it, so a committed one means the data is wrong.
    if (stored.status !== 'COMPLETED') {
      throw new Error(
        `Transfer ${stored.id} was found with status ${stored.status}, expected COMPLETED or FAILED`,
      );
    }

    const sourceEntry = stored.entries.find(
      (item) => item.walletId === sourceWalletId,
    );
    if (!sourceEntry) {
      throw new Error(
        `Transfer ${stored.id} has no ledger entry for its source wallet`,
      );
    }

    return {
      replayed: true,
      result: {
        id: stored.id,
        type: stored.type,
        status: stored.status,
        amount: stored.amount,
        currency: stored.currency,
        sourceWalletId,
        destinationWalletId,
        description: stored.description,
        balanceAfter: sourceEntry.balanceAfter,
        createdAt: stored.createdAt,
      },
    };
  }
}
