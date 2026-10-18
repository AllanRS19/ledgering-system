import { HttpStatus, UnprocessableEntityException } from '@nestjs/common';
import { INSUFFICIENT_FUNDS_MESSAGE } from '../ledger/ledger-client-messages';

/**
 * Raised when a retry hits a transfer that was recorded as FAILED for
 * insufficient funds. The original InsufficientFundsError carried internal
 * numbers (wallet, balance) that were never stored, so the real error cannot
 * be rebuilt. This one has the same client-visible body, from the same message.
 */
export class InsufficientFundsReplayException extends UnprocessableEntityException {
  constructor() {
    super({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'INSUFFICIENT_FUNDS',
      message: INSUFFICIENT_FUNDS_MESSAGE,
    });
  }
}
