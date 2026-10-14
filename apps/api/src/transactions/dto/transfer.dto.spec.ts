import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TransferFundsDto } from './transfer.dto';

const SOURCE_ID = randomUUID();
const DESTINATION_ID = randomUUID();

// Same options the global ValidationPipe uses in main.ts.
const run = async (payload: unknown) => {
  const dto = plainToInstance(TransferFundsDto, payload);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
};

const validPayload = (overrides: Record<string, unknown> = {}) => ({
  sourceWalletId: SOURCE_ID,
  destinationWalletId: DESTINATION_ID,
  amount: '3000',
  ...overrides,
});

describe('TransferFundsDto', () => {
  describe('a valid payload', () => {
    it('is accepted without a description', async () => {
      const { dto, errors } = await run(validPayload());

      expect(errors).toHaveLength(0);
      expect(dto.description).toBeUndefined();
    });

    it('is accepted with a description', async () => {
      const { dto, errors } = await run(validPayload({ description: 'rent' }));

      expect(errors).toHaveLength(0);
      expect(dto.description).toBe('rent');
    });
  });

  describe('description', () => {
    it('is trimmed', async () => {
      const { dto, errors } = await run(
        validPayload({ description: '  rent  ' }),
      );

      expect(errors).toHaveLength(0);
      expect(dto.description).toBe('rent');
    });

    it.each(['', '   '])(
      'counts the blank value %p as "not sent"',
      async (description) => {
        const { dto, errors } = await run(validPayload({ description }));

        expect(errors).toHaveLength(0);
        expect(dto.description).toBeUndefined();
      },
    );

    it('accepts exactly 200 characters', async () => {
      const { errors } = await run(
        validPayload({ description: 'a'.repeat(200) }),
      );

      expect(errors).toHaveLength(0);
    });

    it('rejects 201 characters', async () => {
      const { errors } = await run(
        validPayload({ description: 'a'.repeat(201) }),
      );

      expect(errors.length).toBeGreaterThan(0);
    });

    it.each([
      ['a number', 5],
      ['an object', {}],
      ['an array', []],
    ])('rejects %s', async (_label, description) => {
      const { errors } = await run(validPayload({ description }));

      expect(errors.length).toBeGreaterThan(0);
    });

    it('treats null like "not sent"', async () => {
      const { errors } = await run(validPayload({ description: null }));

      expect(errors).toHaveLength(0);
    });
  });

  describe.each(['sourceWalletId', 'destinationWalletId'])('%s', (field) => {
    it.each([
      ['not a UUID', 'not-a-uuid'],
      ['an empty string', ''],
      ['a number', 123],
      ['null', null],
      ['undefined', undefined],
    ])('rejects %s', async (_label, value) => {
      const { errors } = await run(validPayload({ [field]: value }));

      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('amount', () => {
    it.each(['1', '3000', '999999999999'])('accepts %p', async (amount) => {
      const { errors } = await run(validPayload({ amount }));

      expect(errors).toHaveLength(0);
    });

    // The full list of amount cases lives with the shared decorator; these
    // only prove that this DTO really uses it.
    it.each([
      ['zero', '0'],
      ['negative', '-5'],
      ['decimal', '1.5'],
      ['letters', 'abc'],
      ['empty string', ''],
      ['13 digits', '1000000000000'],
      ['a JSON number', 3000],
      ['undefined', undefined],
    ])('rejects %s', async (_label, amount) => {
      const { errors } = await run(validPayload({ amount }));

      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('unknown fields', () => {
    it.each(['userId', 'currency', 'isSystem', 'fromWalletId'])(
      'rejects an extra %s field',
      async (field) => {
        const { errors } = await run(validPayload({ [field]: 'x' }));

        expect(errors.length).toBeGreaterThan(0);
      },
    );
  });
});
