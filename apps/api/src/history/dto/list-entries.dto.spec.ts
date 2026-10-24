import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListEntriesQueryDto } from './list-entries.dto';

const run = async (query: Record<string, unknown>) => {
  const dto = plainToInstance(ListEntriesQueryDto, query);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
};

describe('ListEntriesQueryDto', () => {
  it('accepts no parameters at all', async () => {
    const { errors } = await run({});

    expect(errors).toHaveLength(0);
  });

  it('inherits the shared page parameters', async () => {
    const { dto, errors } = await run({
      limit: '50',
      cursor: 'abc',
      from: '2026-01-01',
      to: '2026-02-01',
    });

    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(50);
  });

  it.each(['0', '101', 'abc'])('rejects the limit %p', async (limit) => {
    const { errors } = await run({ limit });

    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a date that does not exist', async () => {
    const { errors } = await run({ from: '2026-02-30' });

    expect(errors.length).toBeGreaterThan(0);
  });

  // Transaction filters do not exist on the statement endpoint.
  it.each(['type', 'status', 'walletId'])(
    'rejects the transactions-only parameter %s',
    async (name) => {
      const { errors } = await run({ [name]: 'DEPOSIT' });

      expect(errors.length).toBeGreaterThan(0);
    },
  );
});
