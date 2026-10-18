import { HttpStatus, UnprocessableEntityException } from '@nestjs/common';

/**
 * The same Idempotency-Key arrived with a different request. That is a bug in
 * the client, and retrying will never fix it, so it is a 422. The body has
 * the same shape as the ledger filter's responses.
 */
export class IdempotencyKeyReusedException extends UnprocessableEntityException {
  constructor() {
    super({
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'This Idempotency-Key was already used for a different request',
    });
  }
}
