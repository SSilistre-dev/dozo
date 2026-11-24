-- Additive: the previous release never reads this table. It belongs to the fork: it has no model in
-- schema.prisma and is read and written with SQL in packages/adapters/src/dozo-device-login-store.ts.

-- A vault login whose value stays in a password manager on one of the user's own computers: the
-- vault item holds only the computer and the handle the computer keeps its link under, and this
-- row says which item that is, so a computer's logins can be listed, and removed when it goes.
-- The row goes with its item. Like user_devices, it is reached only by the device's own token and
-- the server, so it has no row policy.
CREATE TABLE "dozo_device_logins" (
  "deviceId" TEXT NOT NULL REFERENCES "user_devices"("id") ON DELETE CASCADE,
  "handle" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL UNIQUE REFERENCES "vault_credentials"("id") ON DELETE CASCADE,
  PRIMARY KEY ("deviceId", "handle")
);

-- A computer that is disconnected (signed out, removed by its owner or by itself, however it was
-- revoked) takes every login it linked with it: the items are removed in the same statement that
-- revokes it, and the rows above with them. Runs as the table owner, which row security on the
-- vault does not hide the items from; it runs only when "revokedAt" is first set.
CREATE FUNCTION dozo_device_logins_on_revoke() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  DELETE FROM public.vault_credentials v
    USING public.dozo_device_logins l
    WHERE l."deviceId" = NEW.id AND v.id = l."credentialId";
  RETURN NULL;
END
$$;
REVOKE EXECUTE ON FUNCTION dozo_device_logins_on_revoke() FROM PUBLIC;
CREATE TRIGGER dozo_device_logins_on_revoke
  AFTER UPDATE OF "revokedAt" ON "user_devices"
  FOR EACH ROW WHEN (OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL)
  EXECUTE FUNCTION dozo_device_logins_on_revoke();
