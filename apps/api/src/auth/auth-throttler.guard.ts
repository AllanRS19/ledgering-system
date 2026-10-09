import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { normalizeEmail } from 'src/common/helpers';

/** Per IP everywhere; per (email, IP) where the request body names an account. */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const ip = await super.getTracker(req);
    const body = req.body as { email?: unknown } | undefined;
    const email =
      typeof body?.email === 'string' ? normalizeEmail(body.email) : '';

    return email ? `${email}|${ip}` : ip;
  }
}
