import { plainToInstance } from 'class-transformer';
import { randomUUID } from 'crypto';
import { DepositFundsDto } from './deposit.dto';
import { validate } from 'class-validator';
import { MAX_POSTING_AMOUNT } from '../../common/constants';

const VALID_WALLET_ID = randomUUID();

// Same options the global ValidationPipe uses in main.ts.
const run = async (payload: unknown) => {
  const dto = plainToInstance(DepositFundsDto, payload);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
};

const withAmount = (amount: unknown) => ({
  walletId: VALID_WALLET_ID,
  amount,
});

describe('DepositFundsDto', () => {
  describe('amount', () => {
    it.each(['1', '100', '500', '999999999999'])(
      'accepts %p',
      async (amount) => {
        const { errors } = await run(withAmount(amount));

        expect(errors).toHaveLength(0);
      },
    );

    it.each([
      ['zero', '0'],
      ['negative', '-5'],
      ['explicit plus sign', '+5'],
      ['decimal', '1.5'],
      ['scientific notation', '1e3'],
      ['letters', 'abc'],
      ['empty string', ''],
      ['leading space', ' 5'],
      ['trailing space', '5 '],
      ['leading zero', '01'],
      ['13 digits, over the limit', '1000000000000'],
      ['non-ASCII digits', '٥٠٠'],
    ])('rejects %s (%p)', async (_label, amount) => {
      const { errors } = await run(withAmount(amount));

      expect(errors.length).toBeGreaterThan(0);
    });

    it.each([
      ['a JSON number', 5000],
      ['null', null],
      ['undefined', undefined],
      ['an object', {}],
      ['an array', []],
    ])('rejects %s instead of throwing', async (_label, amount) => {
      const { errors } = await run(withAmount(amount));

      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a missing amount', async () => {
      const { errors } = await run({ walletId: VALID_WALLET_ID });

      expect(errors.length).toBeGreaterThan(0);
    });

    it("never accepts more than the ledger's maximum, and BigInt() never throws on it", async () => {
      const largestAccepted = '9'.repeat(12);
      const { errors } = await run(withAmount(largestAccepted));

      expect(errors).toHaveLength(0);
      expect(BigInt(largestAccepted)).toBeLessThanOrEqual(MAX_POSTING_AMOUNT);
    });
  });

  describe('walletId', () => {
    it('accepts a UUID', async () => {
      const { errors } = await run(withAmount('100'));

      expect(errors).toHaveLength(0);
    });

    it.each([
      ['not a UUID', 'not-a-uuid'],
      ['empty string', ''],
      ['a number', 123],
      ['null', null],
      ['undefined', undefined],
    ])('rejects %s', async (_label, walletId) => {
      const { errors } = await run({ walletId, amount: '100' });

      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('unknown fields', () => {
    it.each(['userId', 'currency', 'isSystem'])(
      'rejects an extra %s field, so the client cannot choose it',
      async (field) => {
        const { errors } = await run({ ...withAmount('100'), [field]: 'x' });

        expect(errors.length).toBeGreaterThan(0);
      },
    );
  });
});
