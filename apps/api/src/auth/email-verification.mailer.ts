import {
  AuthenticationRegistry,
  EmailVerificationHandler,
  EmailVerificationLink,
} from '@nestjs/authentication';
import { Injectable } from '@nestjs/common';
import { Mailable, Mailer } from '@nestjs/mail';
import { UsersService } from '../users/users.service';

@Injectable()
export class VerifyEmailMail implements Mailable<EmailVerificationLink> {
  render({ url }: EmailVerificationLink) {
    return {
      subject: 'Confirm your email address',
      template: 'verify-email',
      context: { url },
    };
  }
}

@Injectable()
export class EmailVerificationMailer extends EmailVerificationHandler {
  constructor(
    private readonly users: UsersService,
    private readonly mailer: Mailer,
    registry: AuthenticationRegistry,
  ) {
    super();
    registry.registerHandler('emailVerification', this);
  }

  async send(link: EmailVerificationLink) {
    await this.mailer.send(VerifyEmailMail, { to: link.email, data: link });
  }

  // Runs when the link is used. It verifies nothing if the address changed since.
  markVerified(userId: string, email: string): Promise<boolean> {
    return this.users.markEmailVerified(userId, email);
  }
}
