import { PasswordHasher } from '@nestjs/authentication';
import { ConflictException, Injectable } from '@nestjs/common';
import type { User } from 'src/users/types/user.types';
import { UsersService } from 'src/users/users.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwordHasher: PasswordHasher,
  ) {}

  async register(name: string, email: string, password: string): Promise<User> {
    // Cheap early exit: hashing costs ~128 MiB of memory, so don't do it for
    // an email we already know is taken. The unique constraint (handled inside
    // users.create) is what actually guarantees there are no duplicates.
    if (await this.users.findByEmail(email)) {
      throw new ConflictException('Email is already taken');
    }

    const passwordHash = await this.passwordHasher.hash(password);

    // The email address is unverified: anyone can type any email into a sign-up form. Enforced by the schema already
    return this.users.create({ name, email, passwordHash });
  }

  /** The user, or `null` when the email or the password is wrong. */
  async login(email: string, password: string): Promise<User | null> {
    const foundUser = await this.users.findCredentials(email);

    // With no account (or no password), login() checks a dummy hash, so the
    // response time does not reveal which emails are registered.
    const valid = await this.passwordHasher.verify(
      password,
      foundUser?.passwordHash,
    );

    if (!valid || !foundUser?.passwordHash) return null;

    // The cost settings changed since this hash was stored: upgrade it now,
    // while we have the plaintext.
    if (this.passwordHasher.needsRehash(foundUser.passwordHash)) {
      await this.users.updatePasswordHash(
        foundUser.user.id,
        await this.passwordHasher.hash(password),
      );
    }

    return foundUser.user;
  }
}
