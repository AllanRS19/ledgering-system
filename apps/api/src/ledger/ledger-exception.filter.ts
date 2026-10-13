import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  LedgerError,
} from './ledger.errors';

/**
 * Translates the ledger's domain errors into HTTP responses.
 *
 * - Errors the client can cause get a 422 and a fixed, friendly message.
 * - Everything else means our own code asked the ledger for something wrong:
 *   it is logged in full and the client only sees a generic 500.
 *
 * The ledger's own messages carry internal ids and balances, so they are
 * never sent to the client.
 */

@Catch(LedgerError)
export class LedgerExceptionFilter implements ExceptionFilter<LedgerError> {
  private readonly logger = new Logger(LedgerExceptionFilter.name);

  catch(exception: LedgerError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof InsufficientFundsError) {
      this.send(
        response,
        HttpStatus.UNPROCESSABLE_ENTITY,
        exception.code,
        'Insufficient funds for this operation',
      );
      return;
    }

    if (exception instanceof CurrencyMismatchError) {
      this.send(
        response,
        HttpStatus.UNPROCESSABLE_ENTITY,
        exception.code,
        'The currencies of the wallets involved do not match',
      );
      return;
    }

    // A bug on our side: keep every detail in the log, none in the response.
    this.logger.error(
      `${exception.name} [${exception.code}]: ${exception.message}`,
      exception.stack,
    );

    this.send(
      response,
      HttpStatus.INTERNAL_SERVER_ERROR,
      'INTERNAL_ERROR',
      'Something went wrong on our side',
    );
  }

  private send(
    response: Response,
    status: number,
    code: string,
    message: string,
  ): void {
    response.status(status).json({ statusCode: status, code, message });
  }
}
