import { Injectable, ConflictException } from '@nestjs/common';
import { User } from './types/user.types';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation, normalizeEmail } from '../common/helpers';

// The only fields allowed to leave this service. Never includes passwordHash
const userSelect = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: userSelect,
    });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: userSelect,
    });
  }

  /** For password sign-in only: the one method that returns the hash. */
  async findCredentials(
    email: string,
  ): Promise<{ user: User; passwordHash: string | null } | null> {
    const row = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: { ...userSelect, passwordHash: true },
    });

    if (!row) return null;

    const { passwordHash, ...user } = row;
    return { user, passwordHash };
  }

  async create(data: {
    name: string;
    email: string;
    passwordHash: string;
  }): Promise<User> {
    try {
      return await this.prisma.user.create({
        data: {
          ...data,
          email: normalizeEmail(data.email),
        },
        select: userSelect,
      });
    } catch (error) {
      // Two sign-ups racing for the same email: the unique constraint is the
      // real guarantee, so a violation here is a normal 409, not a 500.
      if (isUniqueViolation(error)) {
        throw new ConflictException('Email is already taken');
      }
      throw error;
    }
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash },
    });
  }

  /**
   * One atomic conditional update: it only matches while the address is still
   * the user's, so a link sent to an old address verifies nothing.
   */
  async markEmailVerified(id: string, email: string): Promise<boolean> {
    const { count } = await this.prisma.user.updateMany({
      where: { id, email: normalizeEmail(email) },
      data: { emailVerified: true },
    });

    return count > 0;
  }
}
