-- Additive: the previous release neither reads nor writes this column, and keeps writing
-- "secretId", which the new release still reads for rows without a holder.
--
-- Who a rest belongs to when it is not the connection's secret. A subscription sign-in that ran
-- out rests for its account (a digest of the provider's account id), so a token refresh or signing
-- in again with the same account keeps the rest and another account ends it. NULL: the rest belongs
-- to the secret in "secretId", as before (keys, own endpoints, a refused sign-in).
ALTER TABLE "dozo_model_connection_cooldowns" ADD COLUMN "holder" TEXT;
