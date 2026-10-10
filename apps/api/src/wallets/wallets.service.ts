import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from '../common/helpers';
import type { SupportedCurrency, WalletSummary } from './types/wallets.types';

const walletSelect = {
  id: true,
  currency: true,
  balance: true,
  createdAt: true,
} as const;

@Injectable()
export class WalletsService {
  constructor(private readonly prisma: PrismaService) {}

  getUserWallets(userId: string): Promise<WalletSummary[]> {
    return this.prisma.wallet.findMany({
      where: { userId },
      select: walletSelect,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getWalletById(
    walletId: string,
    userId: string,
  ): Promise<WalletSummary> {
    // Filtering by userId makes someone else's wallet look exactly like a
    // wallet that doesn't exist.
    const wallet = await this.prisma.wallet.findFirst({
      where: { userId, id: walletId },
      select: walletSelect,
    });

    if (!wallet) throw new NotFoundException('Wallet was not found');

    return wallet;
  }

  async createUserWallet(currency: SupportedCurrency, userId: string) {
    // 1. Make sure the funding wallet for this currency exists. createMany
    // with skipDuplicates is INSERT ... ON CONFLICT DO NOTHING, so it is
    // idempotent and safe when two first-time users race for a new currency.
    // Doing it first keeps the invariant "a user wallet exists only if its
    // funding wallet does", even if the process dies between the two steps.
    await this.prisma.wallet.createMany({
      data: [{ userId: null, currency, isSystem: true }],
      skipDuplicates: true,
    });

    // 2. Create the user's own wallet. The only unique rule it can break is
    // (userId, currency), so a violation means "you already have one".
    try {
      return await this.prisma.wallet.create({
        data: {
          userId,
          currency: currency,
        },
        select: walletSelect,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Wallet with this currency already exists');
      }
      throw error;
    }
  }
}
