import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  PlannedEntry,
  PostingRequest,
  WalletState,
} from './types/ledger.types';
import { assertValidLines, planPosting } from './posting';

// The shape of a row coming back from the raw locking query below
interface LockedWalletRow {
  id: string;
  currency: string;
  balance: bigint | number | string;
  isSystem: boolean;
}

@Injectable()
export class LedgerService {
  /**
   * The ONLY place that writes ledger entries and changes wallet balances.
   *
   * `tx` must be a transaction opened by the caller: this method never opens
   * its own, so everything it writes commits or rolls back together with
   * whatever else the caller does in that transaction.
   */
  async post(
    tx: Prisma.TransactionClient,
    request: PostingRequest,
  ): Promise<PlannedEntry[]> {
    // 1. Reject nonsense before touching the database
    assertValidLines(request.lines);

    // 2. Lock every wallet involved, in a fixed order (sorted by id), so two
    // postings that touch the same wallets can never wait on each other in a
    // circle. Other transactions wanting these rows now wait until this one
    // commits or rolls back, and read the new balances afterwards.
    const walletIds = request.lines.map((line) => line.walletId).sort();

    const rows = await tx.$queryRaw<LockedWalletRow[]>`
    SELECT id, currency, balance, "isSystem"
    FROM "Wallet"
    WHERE id IN (${Prisma.join(walletIds)})
    ORDER BY id
    FOR UPDATE
    `;

    // 3. These balances are trustworthy: nobody else can change them now.
    // BigInt(...) accepts a bigint, a number or a string, so it does not
    // matter how the database driver returns a bigint column.
    const wallets: WalletState[] = rows.map((row) => ({
      id: row.id,
      currency: row.currency,
      balance: BigInt(row.balance),
      isSystem: row.isSystem,
    }));

    // 4. All the rules live in the pure function. It throws if anything is
    // wrong, and nothing has been written yet.
    const plan = planPosting(request.currency, request.lines, wallets);

    // 5. Write the entries, then the new balances.
    await tx.ledgerEntry.createMany({
      data: plan.entries.map((entry) => ({
        transactionId: request.transactionId,
        walletId: entry.walletId,
        direction: entry.direction,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter,
      })),
    });

    for (const [walletId, balance] of plan.newBalances) {
      await tx.wallet.update({
        where: { id: walletId },
        data: { balance },
      });
    }

    return plan.entries;
  }
}
