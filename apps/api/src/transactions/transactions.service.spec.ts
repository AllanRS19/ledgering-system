import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  UnbalancedPostingError,
} from '../ledger/ledger.errors';
import type { PrismaService } from '../prisma/prisma.service';
import { IdempotencyKeyReusedException } from './idempotency-key-reused.exception';
import { InsufficientFundsReplayException } from './insufficient-funds-replay.exception';
import { hashRequest } from './request-hash';
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
const NOW = new Date('2026-01-01T00:00:00.000Z');

/** What Prisma throws when a unique rule is broken. */
const uniqueViolation = () =>
  Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

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
      findMany: jest.fn<
        Promise<unknown>,
        [{ where: Record<string, unknown>; select?: Record<string, unknown> }]
      >(),
    },
    transaction: {
      create: jest.fn<Promise<unknown>, [{ data: Record<string, unknown> }]>(),
      update: jest.fn<
        Promise<unknown>,
        [{ where: Record<string, unknown>; data: Record<string, unknown> }]
      >(),
    },
  };
  const ledger = {
    post: jest.fn<Promise<PlannedEntry[]>, [unknown, PostingRequest]>(),
  };
  // $transaction, plus the one lookup that runs OUTSIDE the transaction (to
  // find a transaction that already has this key). There is no `wallet`
  // here: any direct use of prisma.wallet would throw.
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
    transaction: {
      findUnique: jest
        .fn<Promise<unknown>, [unknown]>()
        .mockResolvedValue(null),
    },
  };

  const service = new TransactionsService(
    ledger,
    prisma as unknown as PrismaService,
  );

  return { service, tx, ledger, prisma };
}

type Mocks = ReturnType<typeof setup>;

/** The arguments of the first ledger.post(...) call, with real types. */
function firstPostCall(ledger: Mocks['ledger']): {
  tx: unknown;
  request: PostingRequest;
} {
  const call = ledger.post.mock.calls[0] as
    [unknown, PostingRequest] | undefined;

  if (!call) {
    throw new Error('ledger.post was never called');
  }

  return { tx: call[0], request: call[1] };
}

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

describe('TransactionsService.depositFunds', () => {
  const payload = {
    userId: USER_ID,
    walletId: 'wallet-1',
    amount: 5000n,
    idempotencyKey: 'key-1',
  };

  const depositHash = hashRequest({
    type: 'DEPOSIT',
    walletId: 'wallet-1',
    amount: 5000n,
  });

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
    createdAt: NOW,
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

  /** A deposit that was already recorded, as the lookup returns it. */
  const storedDeposit = (overrides: Record<string, unknown> = {}) => ({
    id: 'tx-1',
    type: 'DEPOSIT',
    status: 'COMPLETED',
    amount: 5000n,
    currency: 'USD',
    description: null,
    failureReason: null,
    requestHash: depositHash,
    createdAt: NOW,
    entries: [
      { walletId: 'funding-1', balanceAfter: -5000n },
      { walletId: 'wallet-1', balanceAfter: 5000n },
    ],
    ...overrides,
  });

  /** The normal case: both wallets exist and the ledger accepts the posting. */
  function primeHappyPath({ tx, ledger }: Mocks) {
    tx.wallet.findFirst
      .mockResolvedValueOnce(userWallet)
      .mockResolvedValueOnce(fundingWallet);
    tx.transaction.create.mockResolvedValue(createdTransaction);
    ledger.post.mockResolvedValue(ledgerEntries);
  }

  it('returns the transaction summary with the new balance of the user wallet', async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    const outcome = await mocks.service.depositFunds(payload);

    // toEqual on the whole object also proves nothing extra is returned,
    // such as the funding wallet's id or the raw ledger entries.
    expect(outcome).toEqual({
      replayed: false,
      result: {
        id: 'tx-1',
        type: 'DEPOSIT',
        status: 'COMPLETED',
        amount: 5000n,
        currency: 'USD',
        walletId: 'wallet-1',
        balanceAfter: 5000n,
        createdAt: NOW,
      },
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

    const { request } = firstPostCall(mocks.ledger);
    expect(request.currency).toBe('EUR');
  });

  it('records a completed DEPOSIT with its idempotency key and request fingerprint', async () => {
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
        requestHash: depositHash,
        initiatedById: USER_ID,
      },
    });
  });

  it('debits the funding wallet and credits the user wallet through the ledger', async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    await mocks.service.depositFunds(payload);

    const { tx: txArgument, request } = firstPostCall(mocks.ledger);

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

  describe('idempotency', () => {
    it("looks for an existing transaction by the caller's id and the key", async () => {
      const mocks = setup();
      primeHappyPath(mocks);

      await mocks.service.depositFunds(payload);

      const [args] = mocks.prisma.transaction.findUnique.mock.calls[0];
      expect(args).toMatchObject({
        where: {
          initiatedById_idempotencyKey: {
            initiatedById: USER_ID,
            idempotencyKey: 'key-1',
          },
        },
      });
    });

    it('replays a finished deposit without opening a transaction or touching the ledger', async () => {
      const mocks = setup();
      mocks.prisma.transaction.findUnique.mockResolvedValue(storedDeposit());

      const outcome = await mocks.service.depositFunds(payload);

      // The balance is the one from back then (5000), not the current one.
      expect(outcome).toEqual({
        replayed: true,
        result: {
          id: 'tx-1',
          type: 'DEPOSIT',
          status: 'COMPLETED',
          amount: 5000n,
          currency: 'USD',
          walletId: 'wallet-1',
          balanceAfter: 5000n,
          createdAt: NOW,
        },
      });
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
      expect(mocks.ledger.post).not.toHaveBeenCalled();
    });

    it('rejects the same key with a different request, and touches nothing', async () => {
      const mocks = setup();
      mocks.prisma.transaction.findUnique.mockResolvedValue(
        storedDeposit({
          requestHash: hashRequest({
            type: 'DEPOSIT',
            walletId: 'wallet-1',
            amount: 9999n,
          }),
        }),
      );

      await expect(mocks.service.depositFunds(payload)).rejects.toBeInstanceOf(
        IdempotencyKeyReusedException,
      );

      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
      expect(mocks.ledger.post).not.toHaveBeenCalled();
    });

    it('rejects a key that was first used for a transfer', async () => {
      const mocks = setup();
      mocks.prisma.transaction.findUnique.mockResolvedValue(
        storedDeposit({
          type: 'TRANSFER',
          requestHash: hashRequest({
            type: 'TRANSFER',
            sourceWalletId: 'wallet-1',
            destinationWalletId: 'wallet-2',
            amount: 5000n,
          }),
        }),
      );

      await expect(mocks.service.depositFunds(payload)).rejects.toBeInstanceOf(
        IdempotencyKeyReusedException,
      );
    });

    it('fails loudly when a stored deposit is not COMPLETED', async () => {
      const mocks = setup();
      mocks.prisma.transaction.findUnique.mockResolvedValue(
        storedDeposit({ status: 'PENDING' }),
      );

      await expect(mocks.service.depositFunds(payload)).rejects.toThrow(
        'was found with status PENDING',
      );
    });

    it('replays the winner when another request with the same key commits first', async () => {
      const mocks = setup();
      // Nothing there at first. After the insert loses the race, it is.
      mocks.prisma.transaction.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(storedDeposit());
      mocks.tx.wallet.findFirst
        .mockResolvedValueOnce(userWallet)
        .mockResolvedValueOnce(fundingWallet);
      mocks.tx.transaction.create.mockRejectedValue(uniqueViolation());

      const outcome = await mocks.service.depositFunds(payload);

      expect(outcome.replayed).toBe(true);
      expect(outcome.result.balanceAfter).toBe(5000n);
      // The lookup after the failure runs outside the aborted transaction.
      expect(mocks.prisma.transaction.findUnique).toHaveBeenCalledTimes(2);
      expect(mocks.ledger.post).not.toHaveBeenCalled();
    });

    it('rejects when the request that won the race was a different one', async () => {
      const mocks = setup();
      mocks.prisma.transaction.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          storedDeposit({ requestHash: 'something-else' }),
        );
      mocks.tx.wallet.findFirst
        .mockResolvedValueOnce(userWallet)
        .mockResolvedValueOnce(fundingWallet);
      mocks.tx.transaction.create.mockRejectedValue(uniqueViolation());

      await expect(mocks.service.depositFunds(payload)).rejects.toBeInstanceOf(
        IdempotencyKeyReusedException,
      );
    });

    it('rethrows the original error when a unique violation finds no winner', async () => {
      const mocks = setup();
      const error = uniqueViolation();
      mocks.tx.wallet.findFirst
        .mockResolvedValueOnce(userWallet)
        .mockResolvedValueOnce(fundingWallet);
      mocks.tx.transaction.create.mockRejectedValue(error);

      await expect(mocks.service.depositFunds(payload)).rejects.toBe(error);
    });

    it('does not mistake other errors for a duplicate key', async () => {
      const mocks = setup();
      const boom = new Error('boom');
      mocks.tx.wallet.findFirst
        .mockResolvedValueOnce(userWallet)
        .mockResolvedValueOnce(fundingWallet);
      mocks.tx.transaction.create.mockRejectedValue(boom);

      await expect(mocks.service.depositFunds(payload)).rejects.toBe(boom);

      // Only the fast-path lookup ran: no second lookup for a non-duplicate.
      expect(mocks.prisma.transaction.findUnique).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

describe('TransactionsService.transferFunds', () => {
  const payload = {
    userId: USER_ID,
    sourceWalletId: 'wallet-alice',
    destinationWalletId: 'wallet-bob',
    amount: 3000n,
    description: 'rent',
    idempotencyKey: 'key-1',
  };

  const transferHash = hashRequest({
    type: 'TRANSFER',
    sourceWalletId: 'wallet-alice',
    destinationWalletId: 'wallet-bob',
    amount: 3000n,
    description: 'rent',
  });

  const aliceWallet = { id: 'wallet-alice', userId: USER_ID, currency: 'USD' };
  const bobWallet = { id: 'wallet-bob', userId: 'user-2', currency: 'USD' };

  const pendingTransfer = {
    id: 'tx-2',
    type: 'TRANSFER',
    status: 'PENDING',
    amount: 3000n,
    currency: 'USD',
    description: 'rent',
    createdAt: NOW,
  };

  const completedTransfer = { ...pendingTransfer, status: 'COMPLETED' };

  const transferEntries: PlannedEntry[] = [
    {
      walletId: 'wallet-alice',
      direction: 'DEBIT',
      amount: 3000n,
      balanceAfter: 7000n,
    },
    {
      walletId: 'wallet-bob',
      direction: 'CREDIT',
      amount: 3000n,
      balanceAfter: 8000n,
    },
  ];

  /** A transfer that was already recorded, as the lookup returns it. */
  const storedTransfer = (overrides: Record<string, unknown> = {}) => ({
    id: 'tx-2',
    type: 'TRANSFER',
    status: 'COMPLETED',
    amount: 3000n,
    currency: 'USD',
    description: 'rent',
    failureReason: null,
    requestHash: transferHash,
    createdAt: NOW,
    entries: [
      { walletId: 'wallet-alice', balanceAfter: 7000n },
      { walletId: 'wallet-bob', balanceAfter: 8000n },
    ],
    ...overrides,
  });

  /** The normal case: both wallets exist and the ledger accepts the posting. */
  function primeHappyPath({ tx, ledger }: Mocks) {
    tx.wallet.findMany.mockResolvedValue([aliceWallet, bobWallet]);
    tx.transaction.create.mockResolvedValue(pendingTransfer);
    tx.transaction.update.mockResolvedValue(completedTransfer);
    ledger.post.mockResolvedValue(transferEntries);
  }

  /** Both wallets exist, but the ledger refuses the posting. */
  function primeLedgerFailure({ tx, ledger }: Mocks, error: Error) {
    tx.wallet.findMany.mockResolvedValue([aliceWallet, bobWallet]);
    tx.transaction.create.mockResolvedValue(pendingTransfer);
    tx.transaction.update.mockResolvedValue({});
    ledger.post.mockRejectedValue(error);
  }

  it("returns the sender's side of the transfer, and nothing about the recipient", async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    const outcome = await mocks.service.transferFunds(payload);

    // balanceAfter is the sender's 7000, never the recipient's 8000.
    expect(outcome).toEqual({
      replayed: false,
      result: {
        id: 'tx-2',
        type: 'TRANSFER',
        status: 'COMPLETED',
        amount: 3000n,
        currency: 'USD',
        sourceWalletId: 'wallet-alice',
        destinationWalletId: 'wallet-bob',
        description: 'rent',
        balanceAfter: 7000n,
        createdAt: NOW,
      },
    });
  });

  it('works without a description', async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    await expect(
      mocks.service.transferFunds({ ...payload, description: undefined }),
    ).resolves.toBeDefined();
  });

  it('runs inside exactly one database transaction', async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    await mocks.service.transferFunds(payload);

    expect(mocks.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('looks up both wallets in one query, and never matches a system wallet', async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    await mocks.service.transferFunds(payload);

    expect(mocks.tx.wallet.findMany).toHaveBeenCalledTimes(1);
    const [args] = mocks.tx.wallet.findMany.mock.calls[0];
    expect(args.where).toEqual({
      id: { in: ['wallet-alice', 'wallet-bob'] },
      isSystem: false,
    });
  });

  it('records a PENDING TRANSFER with the description, key and request fingerprint', async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    await mocks.service.transferFunds(payload);

    expect(mocks.tx.transaction.create).toHaveBeenCalledWith({
      data: {
        type: 'TRANSFER',
        status: 'PENDING',
        amount: 3000n,
        currency: 'USD',
        description: 'rent',
        idempotencyKey: 'key-1',
        requestHash: transferHash,
        initiatedById: USER_ID,
      },
    });
  });

  it('debits the source and credits the destination through the ledger', async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    await mocks.service.transferFunds(payload);

    const { tx: txArgument, request } = firstPostCall(mocks.ledger);

    // It must receive the transaction client, never open its own.
    expect(txArgument).toBe(mocks.tx);
    expect(request.transactionId).toBe('tx-2');
    expect(request.currency).toBe('USD');
    expect(request.lines).toHaveLength(2);
    expect(request.lines).toContainEqual({
      walletId: 'wallet-alice',
      direction: 'DEBIT',
      amount: 3000n,
    });
    expect(request.lines).toContainEqual({
      walletId: 'wallet-bob',
      direction: 'CREDIT',
      amount: 3000n,
    });
  });

  it('creates the row before the money moves, and marks it COMPLETED only afterwards', async () => {
    const mocks = setup();
    primeHappyPath(mocks);

    await mocks.service.transferFunds(payload);

    const createdAt = mocks.tx.transaction.create.mock.invocationCallOrder[0];
    const postedAt = mocks.ledger.post.mock.invocationCallOrder[0];
    const updatedAt = mocks.tx.transaction.update.mock.invocationCallOrder[0];

    expect(createdAt).toBeLessThan(postedAt);
    expect(postedAt).toBeLessThan(updatedAt);
    expect(mocks.tx.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-2' },
      data: { status: 'COMPLETED' },
    });
  });

  describe('requests that are rejected before any money moves', () => {
    function expectNothingStored({ tx, ledger }: Mocks) {
      expect(tx.transaction.create).not.toHaveBeenCalled();
      expect(tx.transaction.update).not.toHaveBeenCalled();
      expect(ledger.post).not.toHaveBeenCalled();
    }

    it('answers 422 for the same wallet, without a lookup or a transaction', async () => {
      const mocks = setup();

      await expect(
        mocks.service.transferFunds({
          ...payload,
          destinationWalletId: payload.sourceWalletId,
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(mocks.prisma.transaction.findUnique).not.toHaveBeenCalled();
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('answers 404 when the source wallet does not exist, or is a system wallet', async () => {
      const mocks = setup();
      // The query excludes system wallets, so both cases look like this.
      mocks.tx.wallet.findMany.mockResolvedValue([bobWallet]);

      await expect(mocks.service.transferFunds(payload)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expectNothingStored(mocks);
    });

    it('answers 404 when the source wallet belongs to someone else', async () => {
      const mocks = setup();
      mocks.tx.wallet.findMany.mockResolvedValue([
        { ...aliceWallet, userId: 'someone-else' },
        bobWallet,
      ]);

      await expect(mocks.service.transferFunds(payload)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expectNothingStored(mocks);
    });

    it('answers 404 when the destination wallet does not exist, or is a system wallet', async () => {
      const mocks = setup();
      mocks.tx.wallet.findMany.mockResolvedValue([aliceWallet]);

      await expect(mocks.service.transferFunds(payload)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expectNothingStored(mocks);
    });

    it('rejects a destination in another currency with the ledger error the filter maps to 422', async () => {
      const mocks = setup();
      mocks.tx.wallet.findMany.mockResolvedValue([
        aliceWallet,
        { ...bobWallet, currency: 'EUR' },
      ]);

      await expect(mocks.service.transferFunds(payload)).rejects.toBeInstanceOf(
        CurrencyMismatchError,
      );

      expectNothingStored(mocks);
    });
  });

  describe('insufficient funds', () => {
    const insufficient = () =>
      new InsufficientFundsError('wallet-alice', 100n, 3000n);

    it('marks the transfer FAILED with the error code, not the message', async () => {
      const mocks = setup();
      primeLedgerFailure(mocks, insufficient());

      await expect(mocks.service.transferFunds(payload)).rejects.toBeDefined();

      expect(mocks.tx.transaction.update).toHaveBeenCalledTimes(1);
      expect(mocks.tx.transaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-2' },
        data: { status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS' },
      });
    });

    it('rethrows the original error afterwards, for the filter to answer 422', async () => {
      const mocks = setup();
      const error = insufficient();
      primeLedgerFailure(mocks, error);

      await expect(mocks.service.transferFunds(payload)).rejects.toBe(error);
    });

    it('commits the FAILED row: the transaction callback returns instead of throwing', async () => {
      const mocks = setup();
      primeLedgerFailure(mocks, insufficient());

      await expect(mocks.service.transferFunds(payload)).rejects.toBeDefined();

      // The fake $transaction hands back the callback's own promise. If the
      // callback had thrown, a real transaction would roll back, and the
      // FAILED row would be lost.
      const callbackResult: unknown =
        mocks.prisma.$transaction.mock.results[0].value;
      await expect(callbackResult).resolves.toMatchObject({ kind: 'failed' });
    });

    it('never marks the transfer COMPLETED', async () => {
      const mocks = setup();
      primeLedgerFailure(mocks, insufficient());

      await expect(mocks.service.transferFunds(payload)).rejects.toBeDefined();

      expect(mocks.tx.transaction.update).not.toHaveBeenCalledWith({
        where: { id: 'tx-2' },
        data: { status: 'COMPLETED' },
      });
    });
  });

  describe('any other failure rolls everything back', () => {
    it('lets other ledger errors through, without recording a FAILED row', async () => {
      const mocks = setup();
      const error = new UnbalancedPostingError(2n, 1n);
      primeLedgerFailure(mocks, error);

      await expect(mocks.service.transferFunds(payload)).rejects.toBe(error);

      expect(mocks.tx.transaction.update).not.toHaveBeenCalled();
    });

    it('makes the transaction callback throw, so the whole transaction rolls back', async () => {
      const mocks = setup();
      primeLedgerFailure(mocks, new UnbalancedPostingError(2n, 1n));

      await expect(mocks.service.transferFunds(payload)).rejects.toBeDefined();

      const callbackResult: unknown =
        mocks.prisma.$transaction.mock.results[0].value;
      await expect(callbackResult).rejects.toBeInstanceOf(
        UnbalancedPostingError,
      );
    });

    it('does not mistake other errors for a duplicate key', async () => {
      const mocks = setup();
      const boom = new Error('boom');
      mocks.tx.wallet.findMany.mockResolvedValue([aliceWallet, bobWallet]);
      mocks.tx.transaction.create.mockRejectedValue(boom);

      await expect(mocks.service.transferFunds(payload)).rejects.toBe(boom);

      expect(mocks.prisma.transaction.findUnique).toHaveBeenCalledTimes(1);
    });

    it('fails loudly if the ledger returns no entry for the source wallet', async () => {
      const mocks = setup();
      mocks.tx.wallet.findMany.mockResolvedValue([aliceWallet, bobWallet]);
      mocks.tx.transaction.create.mockResolvedValue(pendingTransfer);
      mocks.ledger.post.mockResolvedValue([transferEntries[1]]);

      await expect(mocks.service.transferFunds(payload)).rejects.toThrow(
        'The ledger returned no entry for wallet wallet-alice',
      );
    });
  });

  describe('idempotency', () => {
    it('replays a finished transfer without opening a transaction or touching the ledger', async () => {
      const mocks = setup();
      mocks.prisma.transaction.findUnique.mockResolvedValue(storedTransfer());

      const outcome = await mocks.service.transferFunds(payload);

      // The sender's balance back then (7000), and nothing about Bob's.
      expect(outcome).toEqual({
        replayed: true,
        result: {
          id: 'tx-2',
          type: 'TRANSFER',
          status: 'COMPLETED',
          amount: 3000n,
          currency: 'USD',
          sourceWalletId: 'wallet-alice',
          destinationWalletId: 'wallet-bob',
          description: 'rent',
          balanceAfter: 7000n,
          createdAt: NOW,
        },
      });
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
      expect(mocks.ledger.post).not.toHaveBeenCalled();
    });

    it('replays a failed transfer as the same 422, without touching the ledger', async () => {
      const mocks = setup();
      mocks.prisma.transaction.findUnique.mockResolvedValue(
        storedTransfer({
          status: 'FAILED',
          failureReason: 'INSUFFICIENT_FUNDS',
          entries: [],
        }),
      );

      await expect(mocks.service.transferFunds(payload)).rejects.toBeInstanceOf(
        InsufficientFundsReplayException,
      );

      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
      expect(mocks.ledger.post).not.toHaveBeenCalled();
    });

    it('fails loudly when a transfer failed for a reason it does not know', async () => {
      const mocks = setup();
      mocks.prisma.transaction.findUnique.mockResolvedValue(
        storedTransfer({
          status: 'FAILED',
          failureReason: 'SOMETHING_NEW',
          entries: [],
        }),
      );

      await expect(mocks.service.transferFunds(payload)).rejects.toThrow(
        'failed for an unknown reason: SOMETHING_NEW',
      );
    });

    it('fails loudly when a stored transfer is still PENDING', async () => {
      const mocks = setup();
      mocks.prisma.transaction.findUnique.mockResolvedValue(
        storedTransfer({ status: 'PENDING', entries: [] }),
      );

      await expect(mocks.service.transferFunds(payload)).rejects.toThrow(
        'was found with status PENDING',
      );
    });

    it.each([
      ['a different amount', { amount: 9999n }],
      ['a different destination', { destinationWalletId: 'wallet-carol' }],
      ['a different description', { description: 'groceries' }],
    ])('rejects the same key with %s', async (_label, change) => {
      const mocks = setup();
      mocks.prisma.transaction.findUnique.mockResolvedValue(storedTransfer());

      await expect(
        mocks.service.transferFunds({ ...payload, ...change }),
      ).rejects.toBeInstanceOf(IdempotencyKeyReusedException);

      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a key that was first used for a deposit', async () => {
      const mocks = setup();
      mocks.prisma.transaction.findUnique.mockResolvedValue(
        storedTransfer({
          type: 'DEPOSIT',
          requestHash: hashRequest({
            type: 'DEPOSIT',
            walletId: 'wallet-alice',
            amount: 3000n,
          }),
        }),
      );

      await expect(mocks.service.transferFunds(payload)).rejects.toBeInstanceOf(
        IdempotencyKeyReusedException,
      );
    });

    it('replays the winner when another request with the same key commits first', async () => {
      const mocks = setup();
      mocks.prisma.transaction.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(storedTransfer());
      mocks.tx.wallet.findMany.mockResolvedValue([aliceWallet, bobWallet]);
      mocks.tx.transaction.create.mockRejectedValue(uniqueViolation());

      const outcome = await mocks.service.transferFunds(payload);

      expect(outcome.replayed).toBe(true);
      expect(outcome.result.balanceAfter).toBe(7000n);
      expect(mocks.prisma.transaction.findUnique).toHaveBeenCalledTimes(2);
      expect(mocks.ledger.post).not.toHaveBeenCalled();
    });

    it('replays the failure when the winner of the race was a failed transfer', async () => {
      const mocks = setup();
      mocks.prisma.transaction.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          storedTransfer({
            status: 'FAILED',
            failureReason: 'INSUFFICIENT_FUNDS',
            entries: [],
          }),
        );
      mocks.tx.wallet.findMany.mockResolvedValue([aliceWallet, bobWallet]);
      mocks.tx.transaction.create.mockRejectedValue(uniqueViolation());

      await expect(mocks.service.transferFunds(payload)).rejects.toBeInstanceOf(
        InsufficientFundsReplayException,
      );
    });

    it('rethrows the original error when a unique violation finds no winner', async () => {
      const mocks = setup();
      const error = uniqueViolation();
      mocks.tx.wallet.findMany.mockResolvedValue([aliceWallet, bobWallet]);
      mocks.tx.transaction.create.mockRejectedValue(error);

      await expect(mocks.service.transferFunds(payload)).rejects.toBe(error);
    });
  });
});
