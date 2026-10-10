-- A system wallet has no owner, and every other wallet has one.
ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_system_has_no_owner"
  CHECK (("isSystem" = true) = ("userId" IS NULL));

-- User wallets can never go negative; funding wallets can,
-- because they track the net amount that entered from outside.
ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_user_balance_non_negative"
  CHECK ("isSystem" = true OR "balance" >= 0);