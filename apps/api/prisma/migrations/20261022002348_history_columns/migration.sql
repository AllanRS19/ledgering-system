-- Stage 8: history support.

-- Wallet ids on transfers, so a FAILED transfer (which has no ledger entries)
-- can still be shown under the right wallet.
ALTER TABLE "Transaction"
  ADD COLUMN "sourceWalletId" TEXT,
  ADD COLUMN "destinationWalletId" TEXT;

-- LedgerEntry.createdAt becomes postedAt. It is a rename, so existing entries
-- keep their timestamps. From now on the column is stamped when the row is
-- inserted (clock_timestamp), not when the transaction started, and has
-- microsecond precision.
DROP INDEX "LedgerEntry_walletId_createdAt_idx";

ALTER TABLE "LedgerEntry" RENAME COLUMN "createdAt" TO "postedAt";
ALTER TABLE "LedgerEntry" ALTER COLUMN "postedAt" DROP DEFAULT;
ALTER TABLE "LedgerEntry"
  ALTER COLUMN "postedAt" TYPE TIMESTAMPTZ(6) USING "postedAt" AT TIME ZONE 'UTC';
ALTER TABLE "LedgerEntry" ALTER COLUMN "postedAt" SET DEFAULT clock_timestamp();

CREATE INDEX "LedgerEntry_walletId_postedAt_idx" ON "LedgerEntry"("walletId", "postedAt");

-- Optional, for development data only: fill the wallet ids of transfers that
-- already completed, from their entries. Old FAILED transfers cannot be filled.
UPDATE "Transaction" t SET "sourceWalletId" = e."walletId"
FROM "LedgerEntry" e
WHERE e."transactionId" = t.id AND t.type = 'TRANSFER' AND e.direction = 'DEBIT';

UPDATE "Transaction" t SET "destinationWalletId" = e."walletId"
FROM "LedgerEntry" e
WHERE e."transactionId" = t.id AND t.type = 'TRANSFER' AND e.direction = 'CREDIT';