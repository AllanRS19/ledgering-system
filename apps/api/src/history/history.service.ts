import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  EntryHistoryItem,
  Page,
  TransactionHistoryItem,
} from './types/history.types';
import { decodeCursor, encodeCursor, type CursorKind } from './cursor';
import { PrismaService } from '../prisma/prisma.service';
import type { ListTransactionsQueryDto } from './dto/list-transactions.dto';
import { DEFAULT_PAGE_SIZE } from '../common/constants';
import type { Prisma } from '../generated/prisma/client';
import { toEntryItem, toTransactionItem } from './history.mapper';
import { ListEntriesQueryDto } from './dto/list-entries.dto';

interface DateRange {
  from?: Date;
  to?: Date;
}

/**
 * Turns rows into a page. The query asked for one row more than the page
 * size: if it came back, there is a next page, and the cursor points at the
 * last row that is actually returned.
 */
function buildPage<Row extends { id: string }, Item>(
  rows: Row[],
  limit: number,
  kind: CursorKind,
  mapRow: (row: Row) => Item,
): Page<Item> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];

  return {
    items: pageRows.map(mapRow),
    nextCursor: hasMore && last ? encodeCursor(kind, last.id) : null,
  };
}

/**
 * Read-only: the user's own transactions and wallet statements. Only the
 * ledger WRITES entries, but reading them from here is fine.
 */
@Injectable()
export class HistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Everything that touched the caller's wallets, newest first: the
   * transactions they started, and the ones that credited or debited one of
   * their wallets (so a recipient sees incoming transfers).
   */
  async listTransactions(
    userId: string,
    query: ListTransactionsQueryDto,
  ): Promise<Page<TransactionHistoryItem>> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const range = this.parseRange(query.from, query.to);
    const cursorId = query.cursor
      ? decodeCursor('transaction', query.cursor)
      : undefined;

    if (query.walletId) {
      await this.assertOwnsWallet(userId, query.walletId);
    }

    // Each filter is one more condition in an AND. Several OR keys in a
    // single object would overwrite each other, and lose the ownership rule.
    const conditions: Prisma.TransactionWhereInput[] = [
      {
        OR: [
          { initiatedById: userId },
          { entries: { some: { wallet: { userId } } } },
        ],
      },
    ];

    if (query.type) conditions.push({ type: query.type });
    if (query.status) conditions.push({ status: query.status });

    if (query.walletId) {
      // A completed transaction is matched through its entries. A failed one
      // // has none, so it is matched through the wallet id stored on it.
      conditions.push({
        OR: [
          { entries: { some: { walletId: query.walletId } } },
          { sourceWalletId: query.walletId },
        ],
      });
    }

    const createdAt = this.dateFilter(range);
    if (createdAt) conditions.push({ createdAt });

    const rows = await this.prisma.transaction.findMany({
      where: { AND: conditions },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      // The database compares against the cursor row itself, with its full
      // precision. Do not compare dates in JavaScript: a Date only keeps
      // milliseconds.
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        currency: true,
        description: true,
        failureReason: true,
        sourceWalletId: true,
        createdAt: true,
        // ONLY the caller's own entries: the other side of a transfer is
        // never loaded, so it cannot leak.
        entries: {
          where: { wallet: { userId } },
          select: {
            walletId: true,
            direction: true,
            balanceAfter: true,
            wallet: { select: { userId: true } },
          },
        },
      },
    });

    return buildPage(rows, limit, 'transaction', (row) =>
      toTransactionItem(row, userId),
    );
  }

  /**
   * The ledger entries of ONE of the caller's wallets, newest first, each
   * with the balance right after it. Sorted by postedAt (when the row was
   * inserted, while the wallet was locked), which follows the order the
   * balance really changed in.
   */
  async listEntries(
    userId: string,
    walletId: string,
    query: ListEntriesQueryDto,
  ): Promise<Page<EntryHistoryItem>> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const range = this.parseRange(query.from, query.to);
    const cursorId = query.cursor
      ? decodeCursor('entry', query.cursor)
      : undefined;

    await this.assertOwnsWallet(userId, walletId);

    const where: Prisma.LedgerEntryWhereInput = { walletId };

    const postedAt = this.dateFilter(range);
    if (postedAt) where.postedAt = postedAt;

    // postedAt has microsecond precision in the database. The Date in the
    // response only keeps milliseconds, which is fine to display: the
    // ordering and the cursor are decided by the database.
    const rows = await this.prisma.ledgerEntry.findMany({
      where,
      orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: {
        id: true,
        direction: true,
        amount: true,
        balanceAfter: true,
        postedAt: true,
        transaction: {
          select: { id: true, type: true, status: true, description: true },
        },
      },
    });

    return buildPage(rows, limit, 'entry', toEntryItem);
  }

  /** Someone else's wallet looks exactly like one that does not exist. */
  private async assertOwnsWallet(
    userId: string,
    walletId: string,
  ): Promise<void> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { id: walletId, userId },
      select: { id: true },
    });

    if (!wallet) {
      throw new NotFoundException('Wallet was not found');
    }
  }

  private parseRange(from?: string, to?: string): DateRange {
    const range: DateRange = {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    };

    if (range.from && range.to && range.from >= range.to) {
      throw new BadRequestException('"from" must be earlier than "to"');
    }

    return range;
  }

  /** `from` is inclusive and `to` exclusive. Undefined when neither is set. */
  private dateFilter(range: DateRange): { gte?: Date; lt?: Date } | undefined {
    if (!range.from && !range.to) {
      return undefined;
    }

    return {
      ...(range.from ? { gte: range.from } : {}),
      ...(range.to ? { lt: range.to } : {}),
    };
  }
}
