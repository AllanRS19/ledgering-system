import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { decodeCursor, encodeCursor } from './cursor';
import { HistoryService } from './history.service';

// The real Prisma service (and with it the generated client) is never loaded.
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

const USER_ID = 'user-1';
const WALLET_ID = randomUUID();
const NOW = new Date('2026-01-01T00:00:00.000Z');

interface FindManyArgs {
  where: unknown;
  orderBy: unknown;
  take: number;
  cursor?: { id: string };
  skip?: number;
  select: unknown;
}

/** Fresh fakes for every test. */
function setup() {
  const prisma = {
    transaction: {
      findMany: jest
        .fn<Promise<unknown>, [FindManyArgs]>()
        .mockResolvedValue([]),
    },
    ledgerEntry: {
      findMany: jest
        .fn<Promise<unknown>, [FindManyArgs]>()
        .mockResolvedValue([]),
    },
    wallet: {
      findFirst: jest
        .fn<Promise<unknown>, [{ where: Record<string, unknown> }]>()
        .mockResolvedValue({ id: WALLET_ID }),
    },
  };

  const service = new HistoryService(prisma as unknown as PrismaService);

  return { service, prisma };
}

type Mocks = ReturnType<typeof setup>;

/** A completed transfer the caller sent, as the query returns it. */
const transferRow = (id = randomUUID()) => ({
  id,
  type: 'TRANSFER',
  status: 'COMPLETED',
  amount: 3000n,
  currency: 'USD',
  description: 'rent',
  failureReason: null,
  sourceWalletId: WALLET_ID,
  createdAt: NOW,
  entries: [
    {
      walletId: WALLET_ID,
      direction: 'DEBIT',
      balanceAfter: 7000n,
      wallet: { userId: USER_ID },
    },
  ],
});

/** A statement entry, as the query returns it. */
const entryRow = (id = randomUUID(), direction = 'DEBIT') => ({
  id,
  direction,
  amount: 3000n,
  balanceAfter: 7000n,
  postedAt: NOW,
  transaction: {
    id: 'tx-1',
    type: 'TRANSFER',
    status: 'COMPLETED',
    description: 'rent',
  },
});

const manyOf = <T>(count: number, make: () => T): T[] =>
  Array.from({ length: count }, make);

/** The arguments of the first findMany call. */
function firstArgs(findMany: Mocks['prisma']['transaction']['findMany']) {
  const call = findMany.mock.calls[0] as [FindManyArgs] | undefined;

  if (!call) {
    throw new Error('findMany was never called');
  }

  return call[0];
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

describe('HistoryService.listTransactions', () => {
  it("returns the caller's items, mapped to their point of view", async () => {
    const mocks = setup();
    mocks.prisma.transaction.findMany.mockResolvedValue([transferRow()]);

    const page = await mocks.service.listTransactions(USER_ID, {});

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      direction: 'OUT',
      walletId: WALLET_ID,
      balanceAfter: 7000n,
    });
    expect(page.nextCursor).toBeNull();
  });

  describe('ownership', () => {
    it('lists what the caller started, or what touched one of their wallets', async () => {
      const mocks = setup();

      await mocks.service.listTransactions(USER_ID, {});

      expect(firstArgs(mocks.prisma.transaction.findMany).where).toEqual({
        AND: [
          {
            OR: [
              { initiatedById: USER_ID },
              { entries: { some: { wallet: { userId: USER_ID } } } },
            ],
          },
        ],
      });
    });

    it("loads only the caller's own entries, never the other side's", async () => {
      const mocks = setup();

      await mocks.service.listTransactions(USER_ID, {});

      expect(firstArgs(mocks.prisma.transaction.findMany).select).toMatchObject(
        {
          entries: { where: { wallet: { userId: USER_ID } } },
        },
      );
    });

    it('keeps the ownership rule when filters are added', async () => {
      const mocks = setup();

      await mocks.service.listTransactions(USER_ID, {
        type: 'TRANSFER',
        status: 'FAILED',
      });

      const { where } = firstArgs(mocks.prisma.transaction.findMany);
      expect(where).toEqual({
        AND: [
          {
            OR: [
              { initiatedById: USER_ID },
              { entries: { some: { wallet: { userId: USER_ID } } } },
            ],
          },
          { type: 'TRANSFER' },
          { status: 'FAILED' },
        ],
      });
    });
  });

  describe('paging', () => {
    it('asks for the default page size plus one', async () => {
      const mocks = setup();

      await mocks.service.listTransactions(USER_ID, {});

      expect(firstArgs(mocks.prisma.transaction.findMany).take).toBe(21);
    });

    it('asks for the requested page size plus one', async () => {
      const mocks = setup();

      await mocks.service.listTransactions(USER_ID, { limit: 5 });

      expect(firstArgs(mocks.prisma.transaction.findMany).take).toBe(6);
    });

    it('sorts newest first, with the id as a tiebreaker', async () => {
      const mocks = setup();

      await mocks.service.listTransactions(USER_ID, {});

      expect(firstArgs(mocks.prisma.transaction.findMany).orderBy).toEqual([
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
    });

    it('returns a cursor to the last returned row when there is another page', async () => {
      const mocks = setup();
      const rows = manyOf(6, () => transferRow());
      mocks.prisma.transaction.findMany.mockResolvedValue(rows);

      const page = await mocks.service.listTransactions(USER_ID, { limit: 5 });

      expect(page.items).toHaveLength(5);
      expect(page.nextCursor).not.toBeNull();
      // The extra row is not returned: the cursor points at the fifth.
      expect(decodeCursor('transaction', page.nextCursor as string)).toBe(
        rows[4].id,
      );
    });

    it('has no cursor on the last page', async () => {
      const mocks = setup();
      mocks.prisma.transaction.findMany.mockResolvedValue(
        manyOf(5, () => transferRow()),
      );

      const page = await mocks.service.listTransactions(USER_ID, { limit: 5 });

      expect(page.items).toHaveLength(5);
      expect(page.nextCursor).toBeNull();
    });

    it('continues after the cursor, skipping the row it points at', async () => {
      const mocks = setup();
      const id = randomUUID();

      await mocks.service.listTransactions(USER_ID, {
        cursor: encodeCursor('transaction', id),
      });

      const args = firstArgs(mocks.prisma.transaction.findMany);
      expect(args.cursor).toEqual({ id });
      expect(args.skip).toBe(1);
    });

    it('does not set a cursor or a skip on the first page', async () => {
      const mocks = setup();

      await mocks.service.listTransactions(USER_ID, {});

      const args = firstArgs(mocks.prisma.transaction.findMany);
      expect(args).not.toHaveProperty('cursor');
      expect(args).not.toHaveProperty('skip');
    });

    it('answers 400 for a cursor that is not valid, without querying', async () => {
      const mocks = setup();

      await expect(
        mocks.service.listTransactions(USER_ID, { cursor: 'garbage' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.prisma.transaction.findMany).not.toHaveBeenCalled();
    });

    it('answers 400 for a cursor from the statement list', async () => {
      const mocks = setup();

      await expect(
        mocks.service.listTransactions(USER_ID, {
          cursor: encodeCursor('entry', randomUUID()),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('filters', () => {
    it('filters by wallet through the entries, or through the stored source wallet', async () => {
      const mocks = setup();

      await mocks.service.listTransactions(USER_ID, { walletId: WALLET_ID });

      const { where } = firstArgs(mocks.prisma.transaction.findMany);
      expect(where).toMatchObject({
        AND: expect.arrayContaining([
          {
            OR: [
              { entries: { some: { walletId: WALLET_ID } } },
              { sourceWalletId: WALLET_ID },
            ],
          },
        ]) as unknown,
      });
    });

    it("checks that the wallet is the caller's, and answers 404 otherwise", async () => {
      const mocks = setup();
      mocks.prisma.wallet.findFirst.mockResolvedValue(null);

      await expect(
        mocks.service.listTransactions(USER_ID, { walletId: WALLET_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(mocks.prisma.wallet.findFirst).toHaveBeenCalledWith({
        where: { id: WALLET_ID, userId: USER_ID },
        select: { id: true },
      });
      expect(mocks.prisma.transaction.findMany).not.toHaveBeenCalled();
    });

    it('does not look up a wallet when there is no wallet filter', async () => {
      const mocks = setup();

      await mocks.service.listTransactions(USER_ID, {});

      expect(mocks.prisma.wallet.findFirst).not.toHaveBeenCalled();
    });

    it('filters by date: from is inclusive, to is exclusive', async () => {
      const mocks = setup();

      await mocks.service.listTransactions(USER_ID, {
        from: '2026-01-01',
        to: '2026-02-01',
      });

      const { where } = firstArgs(mocks.prisma.transaction.findMany);
      expect(where).toMatchObject({
        AND: expect.arrayContaining([
          {
            createdAt: {
              gte: new Date('2026-01-01'),
              lt: new Date('2026-02-01'),
            },
          },
        ]) as unknown,
      });
    });

    it.each([
      ['from is after to', { from: '2026-02-01', to: '2026-01-01' }],
      ['from equals to', { from: '2026-01-01', to: '2026-01-01' }],
    ])('answers 400 when %s, without querying', async (_label, range) => {
      const mocks = setup();

      await expect(
        mocks.service.listTransactions(USER_ID, range),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.prisma.transaction.findMany).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

describe('HistoryService.listEntries', () => {
  it("answers 404 for a wallet that is not the caller's, without reading entries", async () => {
    const mocks = setup();
    mocks.prisma.wallet.findFirst.mockResolvedValue(null);

    await expect(
      mocks.service.listEntries(USER_ID, WALLET_ID, {}),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(mocks.prisma.wallet.findFirst).toHaveBeenCalledWith({
      where: { id: WALLET_ID, userId: USER_ID },
      select: { id: true },
    });
    expect(mocks.prisma.ledgerEntry.findMany).not.toHaveBeenCalled();
  });

  it('reads the entries of that wallet, newest first by postedAt', async () => {
    const mocks = setup();

    await mocks.service.listEntries(USER_ID, WALLET_ID, {});

    const args = firstArgs(mocks.prisma.ledgerEntry.findMany);
    expect(args.where).toEqual({ walletId: WALLET_ID });
    expect(args.orderBy).toEqual([{ postedAt: 'desc' }, { id: 'desc' }]);
    expect(args.take).toBe(21);
  });

  it('maps the entries to money in and out, with the balance after each', async () => {
    const mocks = setup();
    mocks.prisma.ledgerEntry.findMany.mockResolvedValue([
      entryRow(randomUUID(), 'DEBIT'),
      entryRow(randomUUID(), 'CREDIT'),
    ]);

    const page = await mocks.service.listEntries(USER_ID, WALLET_ID, {});

    expect(page.items.map((item) => item.direction)).toEqual(['OUT', 'IN']);
    expect(page.items[0]).toMatchObject({ amount: 3000n, balanceAfter: 7000n });
  });

  it('returns an entry cursor when there is another page', async () => {
    const mocks = setup();
    const rows = manyOf(4, () => entryRow());
    mocks.prisma.ledgerEntry.findMany.mockResolvedValue(rows);

    const page = await mocks.service.listEntries(USER_ID, WALLET_ID, {
      limit: 3,
    });

    expect(page.items).toHaveLength(3);
    expect(decodeCursor('entry', page.nextCursor as string)).toBe(rows[2].id);
  });

  it('has no cursor on the last page', async () => {
    const mocks = setup();
    mocks.prisma.ledgerEntry.findMany.mockResolvedValue(
      manyOf(3, () => entryRow()),
    );

    const page = await mocks.service.listEntries(USER_ID, WALLET_ID, {
      limit: 3,
    });

    expect(page.nextCursor).toBeNull();
  });

  it('continues after the cursor, skipping the row it points at', async () => {
    const mocks = setup();
    const id = randomUUID();

    await mocks.service.listEntries(USER_ID, WALLET_ID, {
      cursor: encodeCursor('entry', id),
    });

    const args = firstArgs(mocks.prisma.ledgerEntry.findMany);
    expect(args.cursor).toEqual({ id });
    expect(args.skip).toBe(1);
  });

  it('answers 400 for a cursor from the transactions list', async () => {
    const mocks = setup();

    await expect(
      mocks.service.listEntries(USER_ID, WALLET_ID, {
        cursor: encodeCursor('transaction', randomUUID()),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('filters by postedAt: from is inclusive, to is exclusive', async () => {
    const mocks = setup();

    await mocks.service.listEntries(USER_ID, WALLET_ID, {
      from: '2026-01-01',
      to: '2026-02-01',
    });

    const args = firstArgs(mocks.prisma.ledgerEntry.findMany);
    expect(args.where).toEqual({
      walletId: WALLET_ID,
      postedAt: {
        gte: new Date('2026-01-01'),
        lt: new Date('2026-02-01'),
      },
    });
  });

  it('answers 400 when from is not before to, without querying', async () => {
    const mocks = setup();

    await expect(
      mocks.service.listEntries(USER_ID, WALLET_ID, {
        from: '2026-02-01',
        to: '2026-01-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(mocks.prisma.ledgerEntry.findMany).not.toHaveBeenCalled();
  });
});
