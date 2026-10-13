import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LedgerService } from '../ledger/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from '../common/helpers';

interface DepositFundsPayload {
  userId: string;
  walletId: string;
  amount: bigint;
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
}
