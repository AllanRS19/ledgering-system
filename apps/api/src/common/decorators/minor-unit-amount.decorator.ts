import { applyDecorators } from '@nestjs/common';
import { Matches } from 'class-validator';
import { MAX_POSTING_AMOUNT } from '../constants';

/**
 * Most digits an amount may have while always staying below
 * MAX_POSTING_AMOUNT. That constant is a power of ten (10^12 has 13 digits),
 * so the answer is 12 (999999999999). Keep it a power of ten, or rewrite
 * this rule.
 */
const MAX_DIGITS = String(MAX_POSTING_AMOUNT).length - 1;

// First digit 1-9 (so no zero and no leading zeros), then up to
// MAX_DIGITS - 1 more digits. Signs, decimals and whitespace do not match.
const AMOUNT_PATTERN = new RegExp(`^[1-9]\\d{0,${MAX_DIGITS - 1}}$`);

/**
 * A money amount sent as a string of digits, in minor units (cents). JSON
 * numbers lose precision, so amounts travel as strings. Anything that passes
 * this check can be handed to BigInt() without throwing, and is always below
 * the ledger's maximum.
 */
export function IsMinorUnitAmount() {
  return applyDecorators(
    Matches(AMOUNT_PATTERN, {
      message: `amount must be a positive whole number of minor units (cents) with at most ${MAX_DIGITS} digits, sent as a string`,
    }),
  );
}
