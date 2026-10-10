/*
  Warnings:

  - A unique constraint covering the columns `[userId,currency]` on the table `Wallet` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[currency]` on the table `Wallet` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Wallet_userId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_currency_key" ON "Wallet"("userId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_currency_key" ON "Wallet"("currency") WHERE ("isSystem" = true);
