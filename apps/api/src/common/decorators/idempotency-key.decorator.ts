import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Reads the required Idempotency-Key header (1 to 255 characters).
 * Money-moving endpoints use it so a retried request cannot move money twice.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers['idempotency-key'];
    const key = (Array.isArray(header) ? header[0] : header)?.trim();

    if (!key || key.length > 255) {
      throw new BadRequestException(
        'An Idempotency-Key header of 1 to 255 characters is required',
      );
    }

    return key;
  },
);
