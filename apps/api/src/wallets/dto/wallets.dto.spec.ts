import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateWalletDto } from './wallets.dto';

// Same options the global ValidationPipe uses in main.ts.
const run = async (payload: unknown) => {
  const dto = plainToInstance(CreateWalletDto, payload);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors };
};

describe('CreateWalletDto', () => {
  it.each(['USD', 'usd', '  usd  ', 'Eur'])(
    'accepts %p and normalizes it to upper case',
    async (input) => {
      const { dto, errors } = await run({ currency: input });

      expect(errors).toHaveLength(0);
      expect(dto.currency).toBe(input.trim().toUpperCase());
    },
  );

  it.each(['XYZ', '', 'U-S-D', 'US D'])(
    'rejects %p without altering it into a valid code',
    async (input) => {
      const { errors } = await run({ currency: input });

      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it.each([undefined, null, 5, {}, []])(
    'rejects the non-string %p with a validation error instead of throwing',
    async (input) => {
      const { errors } = await run({ currency: input });

      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it('rejects unknown fields such as isSystem', async () => {
    const { errors } = await run({ currency: 'USD', isSystem: true });

    expect(errors.length).toBeGreaterThan(0);
  });
});
