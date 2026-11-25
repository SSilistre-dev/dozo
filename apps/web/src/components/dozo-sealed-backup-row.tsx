import { Trans, useLingui } from "@lingui/react/macro";
import { isIdentityConfirmationRequired } from "@rakazo/contracts";
import { dozoLocalDay } from "@rakazo/core";
import {
  SEALED_MIN_PASSWORD_LENGTH,
  SEALED_OPEN_MIN_PASSWORD_LENGTH,
} from "@rakazo/core/dozo-sealed-file";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Spinner,
} from "@rakazo/ui-web";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { queryClient, useSave } from "../lib/query/query";
import { recheckSessionOnUnauthorized } from "../lib/query/rpc";
import { errorText } from "../../../../packages/i18n/src/user-error";
import { SuccessPop } from "./ai/primitives";
import { useIdentityConfirmation } from "./account/ConfirmIdentityDialog";
import { SettingsRow } from "./settings/SettingsRows";

/**
 * Settings > Data: the account as one file sealed with a password, and back. The password never
 * leaves the page: the backup is the account export sealed here, the restore opens the file here
 * and sends the zip inside it to the account import, both unchanged on the server.
 */
export function DozoSealedBackupRow({ onImported }: { onImported?: () => Promise<void> }) {
  const { t } = useLingui();
  const fileInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<{ restore: File | null } | null>(null);
  const [done, setDone] = useState(false);
  // The last download's URL stays readable until the next one or until settings close: WebKit
  // reads it after the click returns.
  const lastUrl = useRef<string | null>(null);
  useEffect(() => () => forget(lastUrl), []);
  const download = (blob: Blob, name: string) => {
    forget(lastUrl);
    lastUrl.current = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = lastUrl.current;
    link.download = name;
    link.click();
  };
  const start = (restore: File | null) => {
    setDone(false);
    setOpen({ restore });
  };
  return (
    <>
      <SettingsRow
        label={<Trans>Backup</Trans>}
        control={
          <>
            {done ? <SuccessPop label={t`Done`} /> : null}
            <Button
              variant="secondary"
              size="sm"
              aria-label={t`Back up`}
              data-testid="dozo-backup-create"
              onClick={() => start(null)}
            >
              <Trans>Back up</Trans>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-label={t`Restore`}
              data-testid="dozo-backup-restore"
              onClick={() => fileInput.current?.click()}
            >
              <Trans>Restore</Trans>
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".dozobackup"
              hidden
              data-testid="dozo-backup-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) start(file);
              }}
            />
          </>
        }
      />
      {open ? (
        // Its own provider, so the row also works where settings are shown without one.
        <QueryClientProvider client={queryClient}>
          <SealDialog
            restore={open.restore}
            download={download}
            onClose={() => setOpen(null)}
            onDone={async () => {
              // The import is done; a list that did not refresh shows it on the next read.
              if (open.restore) {
                await onImported?.().catch((error: unknown) => {
                  console.warn("Restored, but the refresh after it failed:", error);
                });
              }
              setOpen(null);
              setDone(true);
            }}
          />
        </QueryClientProvider>
      ) : null}
    </>
  );
}

function forget(url: { current: string | null }) {
  if (url.current) URL.revokeObjectURL(url.current);
  url.current = null;
}

/** A refusal from the server, with the sentence it sent when it sent one. */
class Refused extends Error {}
/** The server could not be reached at all. */
class Unreachable extends Error {}
/** A file or export larger than a restore takes back. */
class TooLarge extends Error {}
/** A wrong password, or a file that is not an intact backup: one answer for both. */
class Unopenable extends Error {}

/** The server's own sentence for a refusal (`{ "error": "..." }`), or "" when it sent none. */
function sentence(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A body that is not JSON (a proxy's page, nothing at all) carries no sentence to show.
    return "";
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : "";
}

async function request(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include", ...init });
  } catch {
    throw new Unreachable();
  }
  recheckSessionOnUnauthorized(response.status);
  if (response.ok) return response;
  throw new Refused(sentence(await response.text()));
}

/**
 * The password, asked twice for a backup. It lives only in this dialog's state: a failure clears
 * it and closing the dialog drops it.
 */
function SealDialog({
  restore,
  download,
  onClose,
  onDone,
}: {
  restore: File | null;
  download: (blob: Blob, name: string) => void;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useLingui();
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const passwordId = useId();
  const confirmId = useId();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const save = useSave<void>({
    save: async (_input, rpc) => {
      // Loaded only now: the sealing code, its limits and scrypt stay out of the first paint.
      const codec = await import("./dozo-sealed-backup-codec");
      if (restore) {
        // Refused before a byte is read: the import takes no more than this anyway.
        if (restore.size > codec.ACCOUNT_BACKUP_MAX_BYTES) throw new TooLarge();
        let zip: Blob;
        try {
          zip = await codec.openAccountBackup(restore, password);
        } catch (error) {
          throw codec.isSealedFileError(error) ? new Unopenable() : error;
        }
        await request("/api/account/import", {
          method: "POST",
          headers: { "content-type": "application/zip" },
          body: zip,
        });
        return;
      }
      const { token } = await withIdentityConfirmation(() => rpc.export.accountToken());
      const exported = await request(`/api/account/export?token=${encodeURIComponent(token)}`, {});
      // A restore takes no more than this: refused from the declared length when there is one,
      // otherwise the moment the body passes it, without reading the rest.
      if (Number(exported.headers.get("content-length")) > codec.ACCOUNT_EXPORT_MAX_BYTES) {
        await exported.body?.cancel();
        throw new TooLarge();
      }
      const zip = await codec.readUpTo(exported.body, codec.ACCOUNT_EXPORT_MAX_BYTES);
      if (!zip) throw new TooLarge();
      const sealed = await codec.sealAccountExport(zip, password);
      download(sealed, `Dozo ${dozoLocalDay(new Date())}.dozobackup`);
    },
    onSaved: onDone,
    onFailed: () => {
      setPassword("");
      setConfirmation("");
    },
    closesScreen: true,
  });
  const failureText = (failure: Error | null) => {
    if (!failure || isIdentityConfirmationRequired(failure)) return null;
    if (failure instanceof Unopenable) return t`Wrong password, or the file is damaged`;
    if (failure instanceof Unreachable) return t`Could not reach the server`;
    if (failure instanceof TooLarge) return t`The file is too large`;
    if (failure instanceof Refused) return failure.message || t`Could not continue`;
    return errorText(failure, t`Could not continue`);
  };
  const message = mismatch ? t`Passwords do not match` : failureText(save.error);
  const close = () => {
    if (!save.pending) onClose();
  };
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent data-testid="dozo-backup-dialog" className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{restore ? <Trans>Restore</Trans> : <Trans>Back up</Trans>}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const different = !restore && password !== confirmation;
            setMismatch(different);
            if (!different) save.run();
          }}
        >
          <Field>
            <FieldLabel htmlFor={passwordId}>{t`Password`}</FieldLabel>
            <Input
              id={passwordId}
              type="password"
              autoComplete={restore ? "current-password" : "new-password"}
              autoFocus
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setMismatch(false);
                save.reset();
              }}
            />
          </Field>
          {restore ? null : (
            <Field>
              <FieldLabel htmlFor={confirmId}>{t`Confirm password`}</FieldLabel>
              <Input
                id={confirmId}
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                  setMismatch(false);
                }}
              />
            </Field>
          )}
          {message ? (
            <p role="alert" className="text-body-sm text-destructive">
              {message}
            </p>
          ) : null}
          <div className="mt-1 flex items-center gap-3">
            <Button
              type="submit"
              data-testid="dozo-backup-submit"
              disabled={
                save.pending ||
                password.length <
                  (restore ? SEALED_OPEN_MIN_PASSWORD_LENGTH : SEALED_MIN_PASSWORD_LENGTH)
              }
              aria-busy={save.pending}
            >
              {save.pending ? <Spinner aria-hidden /> : null}
              {restore ? <Trans>Restore</Trans> : <Trans>Back up</Trans>}
            </Button>
            <Button
              type="button"
              variant="ghost"
              data-testid="dozo-backup-cancel"
              disabled={save.pending}
              onClick={close}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
        {identityDialog}
      </DialogContent>
    </Dialog>
  );
}
