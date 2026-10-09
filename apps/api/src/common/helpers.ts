export const normalizeEmail = (email: string) =>
  email.trim().normalize('NFC').toLowerCase();

/** True when a Prisma error is a unique-constraint violation (code P2002). */
export const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'P2002';
