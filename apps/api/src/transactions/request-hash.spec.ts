import { hashRequest, type HashableRequest } from './request-hash';

const deposit = (
  overrides: Partial<Extract<HashableRequest, { type: 'DEPOSIT' }>> = {},
): HashableRequest => ({
  type: 'DEPOSIT',
  walletId: 'wallet-1',
  amount: 5000n,
  ...overrides,
});

const transfer = (
  overrides: Partial<Extract<HashableRequest, { type: 'TRANSFER' }>> = {},
): HashableRequest => ({
  type: 'TRANSFER',
  sourceWalletId: 'wallet-a',
  destinationWalletId: 'wallet-b',
  amount: 3000n,
  description: 'rent',
  ...overrides,
});

describe('hashRequest', () => {
  it('is a 64-character hex string', () => {
    expect(hashRequest(deposit())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same fingerprint to the same request', () => {
    expect(hashRequest(deposit())).toBe(hashRequest(deposit()));
    expect(hashRequest(transfer())).toBe(hashRequest(transfer()));
  });

  describe('a deposit changes its fingerprint when', () => {
    it.each([
      ['the wallet changes', deposit({ walletId: 'wallet-2' })],
      ['the amount changes', deposit({ amount: 5001n })],
    ])('%s', (_label, changed) => {
      expect(hashRequest(changed)).not.toBe(hashRequest(deposit()));
    });
  });

  describe('a transfer changes its fingerprint when', () => {
    it.each([
      ['the source changes', transfer({ sourceWalletId: 'wallet-x' })],
      [
        'the destination changes',
        transfer({ destinationWalletId: 'wallet-x' }),
      ],
      ['the amount changes', transfer({ amount: 3001n })],
      ['the description changes', transfer({ description: 'groceries' })],
    ])('%s', (_label, changed) => {
      expect(hashRequest(changed)).not.toBe(hashRequest(transfer()));
    });

    it('swaps source and destination', () => {
      expect(
        hashRequest(
          transfer({
            sourceWalletId: 'wallet-b',
            destinationWalletId: 'wallet-a',
          }),
        ),
      ).not.toBe(hashRequest(transfer()));
    });
  });

  describe('the description counts as "not sent" when it is', () => {
    const withoutDescription = hashRequest(
      transfer({ description: undefined }),
    );

    it.each([
      ['null', null],
      ['empty', ''],
      ['blank', '   '],
    ])('%s', (_label, description) => {
      expect(hashRequest(transfer({ description }))).toBe(withoutDescription);
    });

    it('is not the same as a real description', () => {
      expect(hashRequest(transfer({ description: 'rent' }))).not.toBe(
        withoutDescription,
      );
    });

    it('ignores surrounding spaces', () => {
      expect(hashRequest(transfer({ description: '  rent  ' }))).toBe(
        hashRequest(transfer({ description: 'rent' })),
      );
    });
  });

  it('never confuses a deposit with a transfer', () => {
    expect(hashRequest(deposit({ walletId: 'a', amount: 1n }))).not.toBe(
      hashRequest(
        transfer({
          sourceWalletId: 'a',
          destinationWalletId: 'a',
          amount: 1n,
          description: undefined,
        }),
      ),
    );
  });

  it('cannot be fooled by ids that concatenate to the same text', () => {
    expect(
      hashRequest(transfer({ sourceWalletId: 'ab', destinationWalletId: 'c' })),
    ).not.toBe(
      hashRequest(transfer({ sourceWalletId: 'a', destinationWalletId: 'bc' })),
    );
  });
});
