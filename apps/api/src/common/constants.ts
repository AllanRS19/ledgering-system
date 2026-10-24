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

/** Items per page when the client does not ask for a size. */
export const DEFAULT_PAGE_SIZE = 20;

/** The most items a client may ask for in one page. */
export const MAX_PAGE_SIZE = 100;
