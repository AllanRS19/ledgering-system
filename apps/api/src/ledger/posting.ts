import { MAX_POSTING_AMOUNT } from '../common/constants';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidPostingError,
  UnbalancedPostingError,
  WalletNotFoundError,
} from './ledger.errors';
import type {
  PlannedEntry,
  PostingLine,
  PostingPlan,
  WalletState,
} from './types/ledger.types';

/**
 * Checks everything that can be checked from the lines alone, before
 * touching the database. Throws a LedgerError on the first rule broken.
 */
export function assertValidLines(lines: readonly PostingLine[]): void {
  if (lines.length < 2) {
    throw new InvalidPostingError('at least two lines are required');
  }

  const seenWallets = new Set<string>();
  let totalDebits = 0n;
  let totalCredits = 0n;

  for (const line of lines) {
    if (!line.walletId) {
      throw new InvalidPostingError('every line needs a walletId');
    }

    if (line.direction !== 'DEBIT' && line.direction !== 'CREDIT') {
      throw new InvalidPostingError(
        `unknow direction "${String(line.direction)}"`,
      );
    }

    if (typeof line.amount !== 'bigint') {
      throw new InvalidPostingError('amounts must be bigint values');
    }

    if (line.amount <= 0n || line.amount > MAX_POSTING_AMOUNT) {
      throw new InvalidPostingError(
        `amount must be between 1 and ${MAX_POSTING_AMOUNT}`,
      );
    }

    if (seenWallets.has(line.walletId)) {
      throw new InvalidPostingError(
        `wallet ${line.walletId} appears more than once`,
      );
    }
    seenWallets.add(line.walletId);

    if (line.direction === 'DEBIT') {
      totalDebits += line.amount;
    } else {
      totalCredits += line.amount;
    }
  }

  if (totalDebits !== totalCredits) {
    throw new UnbalancedPostingError(totalDebits, totalCredits);
  }
}

/**
 * Given the lines and the current state of the wallets they touch, works out
 * what to write: one entry per line, and each wallet's new balance.
 * Writes nothing and never changes its inputs.
 */
export function planPosting(
  currency: string,
  lines: readonly PostingLine[],
  wallets: readonly WalletState[],
): PostingPlan {
  // Cheap, and it makes this function safe if a caller skipped the check
  assertValidLines(lines);

  const walletsById = new Map(
    wallets.map((wallet) => [wallet.id, wallet] as const),
  );

  const entries: PlannedEntry[] = [];
  const newBalances = new Map<string, bigint>();

  for (const line of lines) {
    const wallet = walletsById.get(line.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(line.walletId);
    }

    if (wallet.currency !== currency) {
      throw new CurrencyMismatchError(wallet.id, wallet.currency, currency);
    }

    const delta = line.direction === 'CREDIT' ? line.amount : -line.amount;
    const balanceAfter = wallet.balance + delta;

    // Funding wallets track money that entered from outside, so only user
    // wallets are forbidden from going below zero.
    if (!wallet.isSystem && balanceAfter < 0n) {
      throw new InsufficientFundsError(wallet.id, wallet.balance, line.amount);
    }

    entries.push({
      walletId: wallet.id,
      direction: line.direction,
      amount: line.amount,
      balanceAfter,
    });
    newBalances.set(wallet.id, balanceAfter);
  }

  return { entries, newBalances };
}
