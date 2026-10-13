import { ArgumentsHost, Logger } from '@nestjs/common';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidPostingError,
  LedgerError,
  UnbalancedPostingError,
  WalletNotFoundError,
} from './ledger.errors';
import { LedgerExceptionFilter } from './ledger-exception.filter';

// A fake HTTP host that records what the filter sends back
const createHost = () => {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
};

describe('LedgerExceptionFilter', () => {
  let filter: LedgerExceptionFilter;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    filter = new LedgerExceptionFilter();
    logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('answers 422 INSUFFICIENT_FUNDS without exposing internal data', () => {
    const { host, status, json } = createHost();

    filter.catch(new InsufficientFundsError('wallet-secret-id', 5n, 9n), host);

    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      statusCode: 422,
      code: 'INSUFFICIENT_FUNDS',
      message: 'Insufficient funds for this operation',
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain('wallet-secret-id');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('answers 422 CURRENCY_MISMATCH', () => {
    const { host, status, json } = createHost();

    filter.catch(new CurrencyMismatchError('w1', 'EUR', 'USD'), host);

    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 422, code: 'CURRENCY_MISMATCH' }),
    );
  });

  it.each<[string, LedgerError]>([
    ['InvalidPostingError', new InvalidPostingError('secret detail')],
    ['UnbalancedPostingError', new UnbalancedPostingError(2n, 1n)],
    ['WalletNotFoundError', new WalletNotFoundError('wallet-secret-id')],
  ])('%s becomes a generic 500 and is logged', (_name, error) => {
    const { host, status, json } = createHost();

    filter.catch(error, host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side',
    });
    expect(JSON.stringify(json.mock.calls)).not.toMatch(/secret/);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
