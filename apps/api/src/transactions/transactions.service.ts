import {
  ConflictException,
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
  TransferFundsPayload,
  TransferOutcome,
  TransferResult,
} from './types/transactions.types';

@Injectable()
export class TransactionsService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly prisma: PrismaService,
  ) {}

  async depositFunds({
    userId,
    walletId,
    amount,
    idempotencyKey,
  }: DepositFundsPayload) {
    try {
      return await this.prisma.$transaction(async (tx) => {
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
    } catch (error) {
      // The only unique rule a write in this flow can break is
      // (initiatedById, idempotencyKey). Stage 6 replaces this 409 with
      // replaying the original result.
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'The Idempotency-Key has already been used',
        );
      }
      throw error;
    }
  }

  async transferFunds({
    userId,
    sourceWalletId,
    destinationWalletId,
    amount,
    description,
    idempotencyKey,
  }: TransferFundsPayload): Promise<TransferResult> {
    // Needs no database: a wallet cannot send to itself
    if (sourceWalletId === destinationWalletId) {
      throw new UnprocessableEntityException(
        'You cannot transfer to the same wallet',
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
      // Only (initiatedById, idempotencyKey) can break here. Stage 6
      // replaces this 409 with replaying the original result.
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'The Idempotency-Key has already been used',
        );
      }
      throw error;
    }

    // The FAILED row is committed by now. Rethrowing lets the exception
    // filter answer 422 INSUFFICIENT_FUNDS.
    if (outcome.kind === 'failed') {
      throw outcome.error;
    }

    return outcome.result;
  }
}
