import {
  AuthenticationRegistry,
  SessionCookieProvider,
  SessionRecord,
} from '@nestjs/authentication';
import { Injectable } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import type { User } from '../users/types/user.types';

@Injectable()
export class SessionAuth extends SessionCookieProvider<User> {
  constructor(
    private readonly users: UsersService,
    registry: AuthenticationRegistry,
  ) {
    super();
    registry.registerProvider(this);
  }

  // Called for every request with a live session cookie.
  // Returning null (the user was deleted) ends the session.
  validate(session: SessionRecord) {
    // `select` keeps passwordHash out: whatever this returns becomes
    // @CurrentUser(). Add any other fields your User type declares.
    return this.users.findById(session.userId);
  }
}
