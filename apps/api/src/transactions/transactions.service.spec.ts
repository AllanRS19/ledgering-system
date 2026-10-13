import { ConflictException, NotFoundException } from '@nestjs/common';
import { UnbalancedPostingError } from '../ledger/ledger.errors';
import type { PrismaService } from '../prisma/prisma.service';
import { TransactionsService } from './transactions.service';
import type {
  PlannedEntry,
  PostingRequest,
} from '../ledger/types/ledger.types';

// Replace the two collaborators' modules with empty classes: the real files
// are never loaded (no generated Prisma client, no database).
jest.mock('../ledger/ledger.service', () => ({
  LedgerService: class LedgerService {},
}));
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

const USER_ID = 'user-1';

const payload = {
  userId: USER_ID,
  walletId: 'wallet-1',
  amount: 5000n,
  idempotencyKey: 'key-1',
};

const userWallet = {
  id: 'wallet-1',
  userId: USER_ID,
  currency: 'USD',
  isSystem: false,
};

const fundingWallet = {
  id: 'funding-1',
  userId: null,
  currency: 'USD',
  isSystem: true,
};

const createdTransaction = {
  id: 'tx-1',
  type: 'DEPOSIT',
  status: 'COMPLETED',
  amount: 5000n,
  currency: 'USD',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const ledgerEntries: PlannedEntry[] = [
  {
    walletId: 'funding-1',
    direction: 'DEBIT',
    amount: 5000n,
    balanceAfter: -5000n,
  },
  {
    walletId: 'wallet-1',
    direction: 'CREDIT',
    amount: 5000n,
    balanceAfter: 5000n,
  },
];

/** Fresh fakes for every test. */
function setup() {
  // Only the methods the service is supposed to use inside the transaction,
  // typed with the argument shapes the tests read back.
  const tx = {
    wallet: {
      findFirst: jest.fn<
        Promise<unknown>,
        [{ where: Record<string, unknown> }]
      >(),
    },
    transaction: {
      create: jest.fn<Promise<unknown>, [{ data: Record<string, unknown> }]>(),
    },
  };
  const ledger = {
    post: jest.fn<Promise<PlannedEntry[]>, [unknown, PostingRequest]>(),
  };
  // Only $transaction: any direct use of prisma.wallet etc. would throw.
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };

  const service = new TransactionsService(
    ledger,
    prisma as unknown as PrismaService,
  );

  return { service, tx, ledger, prisma };
}

type Mocks = ReturnType<typeof setup>;

/** The normal case: both wallets exist and the ledger accepts the posting. */
function primeHappyPath({ tx, ledger }: Mocks) {
  tx.wallet.findFirst
    .mockResolvedValueOnce(userWallet)
    .mockResolvedValueOnce(fundingWallet);
  tx.transaction.create.mockResolvedValue(createdTransaction);
  ledger.post.mockResolvedValue(ledgerEntries);
}

describe('TransactionsService.depositFunds', () => {
  it('returns the transaction summary with the new balance of the user wallet', async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    const result = await mocks.service.depositFunds(payload);

    // toEqual on the whole object also proves nothing extra is returned,
    // such as the funding wallet's id or the raw ledger entries.
    expect(result).toEqual({
      id: 'tx-1',
      type: 'DEPOSIT',
      status: 'COMPLETED',
      amount: 5000n,
      currency: 'USD',
      walletId: 'wallet-1',
      balanceAfter: 5000n,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('runs inside exactly one database transaction', async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    await mocks.service.depositFunds(payload);

    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("only looks for the wallet among the caller's own wallets", async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    await mocks.service.depositFunds(payload);

    expect(mocks.tx.wallet.findFirst).toHaveBeenNthCalledWith(1, {
      where: { id: 'wallet-1', userId: USER_ID },
    });
  });

  it('takes the currency from the wallet, not from the request', async () => {
    const mocks = setup();
    mocks.tx.wallet.findFirst
      .mockResolvedValueOnce({ ...userWallet, currency: 'EUR' })
      .mockResolvedValueOnce({ ...fundingWallet, currency: 'EUR' });
    mocks.tx.transaction.create.mockResolvedValue({
      ...createdTransaction,
      currency: 'EUR',
    });
    mocks.ledger.post.mockResolvedValue(ledgerEntries);

    await mocks.service.depositFunds(payload);

    // The funding wallet is searched in the user wallet's currency...
    expect(mocks.tx.wallet.findFirst).toHaveBeenNthCalledWith(2, {
      where: { currency: 'EUR', isSystem: true },
    });

    // ...and both the Transaction row and the ledger request use it too.
    const [createArgs] = mocks.tx.transaction.create.mock.calls[0];
    expect(createArgs.data.currency).toBe('EUR');

    const [, request] = mocks.ledger.post.mock.calls[0];
    expect(request.currency).toBe('EUR');
  });

  it('records the deposit as a completed DEPOSIT with the idempotency key', async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    await mocks.service.depositFunds(payload);

    expect(mocks.tx.transaction.create).toHaveBeenCalledWith({
      data: {
        type: 'DEPOSIT',
        status: 'COMPLETED',
        amount: 5000n,
        currency: 'USD',
        idempotencyKey: 'key-1',
        initiatedById: USER_ID,
      },
    });
  });

  it('debits the funding wallet and credits the user wallet through the ledger', async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    await mocks.service.depositFunds(payload);

    const [txArgument, request] = mocks.ledger.post.mock.calls[0];

    // It must receive the transaction client, never open its own.
    expect(txArgument).toBe(mocks.tx);
    expect(request.transactionId).toBe('tx-1');
    expect(request.currency).toBe('USD');
    expect(request.lines).toHaveLength(2);
    // Order does not matter: the ledger sorts its own locks.
    expect(request.lines).toContainEqual({
      walletId: 'funding-1',
      direction: 'DEBIT',
      amount: 5000n,
    });
    expect(request.lines).toContainEqual({
      walletId: 'wallet-1',
      direction: 'CREDIT',
      amount: 5000n,
    });
  });

  it('creates the Transaction row before any money moves', async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    await mocks.service.depositFunds(payload);

    const createdAt = mocks.tx.transaction.create.mock.invocationCallOrder[0];
    const postedAt = mocks.ledger.post.mock.invocationCallOrder[0];
    expect(createdAt).toBeLessThan(postedAt);
  });

  describe('when something is wrong', () => {
    it("answers 404 for a wallet that is missing or not the caller's, and touches nothing", async () => {
      const mocks = setup();
      mocks.tx.wallet.findFirst.mockResolvedValueOnce(null);

      await expect(mocks.service.depositFunds(payload)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(mocks.tx.transaction.create).not.toHaveBeenCalled();
      expect(mocks.ledger.post).not.toHaveBeenCalled();
    });

    it('fails with a plain error when the funding wallet is missing, and touches nothing', async () => {
      const mocks = setup();
      mocks.tx.wallet.findFirst
        .mockResolvedValueOnce(userWallet)
        .mockResolvedValueOnce(null);

      await expect(mocks.service.depositFunds(payload)).rejects.toThrow(
        'No funding wallet for USD',
      );

      expect(mocks.tx.transaction.create).not.toHaveBeenCalled();
      expect(mocks.ledger.post).not.toHaveBeenCalled();
    });

    it('answers 409 when the idempotency key was already used', async () => {
      const mocks = setup();
      mocks.tx.wallet.findFirst
        .mockResolvedValueOnce(userWallet)
        .mockResolvedValueOnce(fundingWallet);
      // What Prisma throws when a unique rule is broken.
      mocks.tx.transaction.create.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      );

      await expect(mocks.service.depositFunds(payload)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(mocks.ledger.post).not.toHaveBeenCalled();
    });

    it('lets ledger errors through untouched, for the exception filter to translate', async () => {
      const mocks = setup();
      mocks.tx.wallet.findFirst
        .mockResolvedValueOnce(userWallet)
        .mockResolvedValueOnce(fundingWallet);
      mocks.tx.transaction.create.mockResolvedValue(createdTransaction);
      mocks.ledger.post.mockRejectedValue(new UnbalancedPostingError(2n, 1n));

      await expect(mocks.service.depositFunds(payload)).rejects.toBeInstanceOf(
        UnbalancedPostingError,
      );
    });

    it('does not mistake other errors for a duplicate key', async () => {
      const mocks = setup();
      const boom = new Error('boom');
      mocks.tx.wallet.findFirst
        .mockResolvedValueOnce(userWallet)
        .mockResolvedValueOnce(fundingWallet);
      mocks.tx.transaction.create.mockRejectedValue(boom);

      await expect(mocks.service.depositFunds(payload)).rejects.toBe(boom);
    });

    it('fails loudly if the ledger returns no entry for the user wallet', async () => {
      const mocks = setup();
      mocks.tx.wallet.findFirst
        .mockResolvedValueOnce(userWallet)
        .mockResolvedValueOnce(fundingWallet);
      mocks.tx.transaction.create.mockResolvedValue(createdTransaction);
      mocks.ledger.post.mockResolvedValue([ledgerEntries[0]]);

      await expect(mocks.service.depositFunds(payload)).rejects.toThrow(
        'The ledger returned no entry for wallet wallet-1',
      );
    });
  });
});
