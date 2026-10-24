import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListTransactionsQueryDto } from './list-transactions.dto';

// Same options the global ValidationPipe uses in main.ts. A real query
// string only ever holds text (or arrays of text, when a name is repeated).
const run = async (query: Record<string, unknown>) => {
  const dto = plainToInstance(ListTransactionsQueryDto, query);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
};

describe('ListTransactionsQueryDto', () => {
  it('accepts no parameters at all', async () => {
    const { errors } = await run({});

    expect(errors).toHaveLength(0);
  });

  describe('limit', () => {
    it('arrives as text and is turned into a number', async () => {
      const { dto, errors } = await run({ limit: '10' });

      expect(errors).toHaveLength(0);
      expect(dto.limit).toBe(10);
    });

    it.each(['1', '20', '100'])('accepts %p', async (limit) => {
      const { errors } = await run({ limit });

      expect(errors).toHaveLength(0);
    });

    it.each(['0', '101', '-1', '1.5', 'abc', '', ['1', '2']])(
      'rejects %p',
      async (limit) => {
        const { errors } = await run({ limit });

        expect(errors.length).toBeGreaterThan(0);
      },
    );
  });

  describe('cursor', () => {
    it('accepts a string', async () => {
      const { errors } = await run({ cursor: 'abc123' });

      expect(errors).toHaveLength(0);
    });

    it.each([['a'.repeat(201)], [['a', 'b']]])(
      'rejects an oversized or repeated cursor',
      async (cursor) => {
        const { errors } = await run({ cursor });

        expect(errors.length).toBeGreaterThan(0);
      },
    );
  });

  describe('type and status', () => {
    it.each(['DEPOSIT', 'TRANSFER'])('accepts the type %s', async (type) => {
      const { errors } = await run({ type });

      expect(errors).toHaveLength(0);
    });

    it.each(['COMPLETED', 'FAILED'])(
      'accepts the status %s',
      async (status) => {
        const { errors } = await run({ status });

        expect(errors).toHaveLength(0);
      },
    );

    it.each(['REVERSAL', 'deposit', 'BANANA', ['DEPOSIT', 'TRANSFER']])(
      'rejects the type %p',
      async (type) => {
        const { errors } = await run({ type });

        expect(errors.length).toBeGreaterThan(0);
      },
    );

    // PENDING exists in the database but is never visible to clients.
    it.each(['PENDING', 'completed', 'BANANA'])(
      'rejects the status %p',
      async (status) => {
        const { errors } = await run({ status });

        expect(errors.length).toBeGreaterThan(0);
      },
    );
  });

  describe('walletId', () => {
    it('accepts a UUID', async () => {
      const { errors } = await run({ walletId: randomUUID() });

      expect(errors).toHaveLength(0);
    });

    it.each(['not-a-uuid', '', ['a', 'b']])('rejects %p', async (walletId) => {
      const { errors } = await run({ walletId });

      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('from and to', () => {
    it.each([
      '2026-01-01',
      '2026-01-01T10:00:00Z',
      '2026-01-01T10:00:00.123+02:00',
    ])('accepts %p', async (value) => {
      const { errors: fromErrors } = await run({ from: value });
      const { errors: toErrors } = await run({ to: value });

      expect(fromErrors).toHaveLength(0);
      expect(toErrors).toHaveLength(0);
    });

    it.each(['2026-02-30', '2026-13-01', 'yesterday', '', '01/02/2026'])(
      'rejects %p',
      async (value) => {
        const { errors: fromErrors } = await run({ from: value });
        const { errors: toErrors } = await run({ to: value });

        expect(fromErrors.length).toBeGreaterThan(0);
        expect(toErrors.length).toBeGreaterThan(0);
      },
    );
  });

  it.each(['userId', 'lmit', 'sort', 'direction'])(
    'rejects the unknown parameter %s',
    async (name) => {
      const { errors } = await run({ [name]: 'x' });

      expect(errors.length).toBeGreaterThan(0);
    },
  );
});
