export const SUPPORTED_CURRENCIES = [
  'USD',
  'EUR',
  'DOP',
  'GBP',
  'AUD',
] as const;

/**
 * Largest amount a single posting line may carry, in minor units (cents).
 * 10^12 cents is 10,000,000,000.00 in a currency with two decimals.
 */
export const MAX_POSTING_AMOUNT = 10n ** 12n;
