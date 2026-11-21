import { Trans, useLingui } from "@lingui/react/macro";
import { isIdentityConfirmationRequired } from "@rakazo/contracts";
import {
  dozoLocalDay,
  MIN_PASSWORD_LENGTH,
  SEALED_ACCOUNT_FILE_MAX_BYTES,
  SealedFileError,
} from "@rakazo/core";
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
import { useId, useRef, useState } from "react";
import { queryClient, useSave } from "../lib/query";
import { recheckSessionOnUnauthorized } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SuccessPop } from "./ai/primitives";
import { useIdentityConfirmation } from "./ConfirmIdentityDialog";
import { SettingsRow } from "./SettingsRows";

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
  const [tooLarge, setTooLarge] = useState(false);
  const start = (restore: File | null) => {
    setDone(false);
    setTooLarge(false);
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
                if (!file) return;
                // Refused before a byte is read: the import takes no more than this anyway.
                if (file.size > SEALED_ACCOUNT_FILE_MAX_BYTES) {
                  setDone(false);
                  setTooLarge(true);
                } else start(file);
              }}
            />
          </>
        }
      >
        {tooLarge ? (
          <p role="alert" className="mt-2 text-body-sm text-destructive">
            {t`The file is too large`}
          </p>
        ) : null}
      </SettingsRow>
      {open ? (
        // Its own provider, so the row also works where settings are shown without one.
        <QueryClientProvider client={queryClient}>
          <SealDialog
            restore={open.restore}
            onClose={() => setOpen(null)}
            onDone={async () => {
              if (open.restore) await onImported?.().catch(() => undefined);
              setOpen(null);
              setDone(true);
            }}
          />
        </QueryClientProvider>
      ) : null}
    </>
  );
}

/** A refusal from the server, with the sentence it sent when it sent one. */
class Refused extends Error {}
/** The server could not be reached at all. */
class Unreachable extends Error {}

async function request(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include", ...init });
  } catch {
    throw new Unreachable();
  }
  recheckSessionOnUnauthorized(response.status);
  if (response.ok) return response;
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  throw new Refused(typeof body?.error === "string" ? body.error : "");
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The password, asked twice for a backup. It lives only in this dialog's state: a failure clears
 * it and closing the dialog drops it.
 */
function SealDialog({
  restore,
  onClose,
  onDone,
}: {
  restore: File | null;
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
      // Loaded only now: the sealing code and scrypt stay out of the first paint.
      const codec = await import("./dozo-sealed-backup-codec");
      if (restore) {
        const zip = await codec.openAccountBackup(restore, password);
        await request("/api/account/import", {
          method: "POST",
          headers: { "content-type": "application/zip" },
          body: zip,
        });
        return;
      }
      const { token } = await withIdentityConfirmation(() => rpc.export.accountToken());
      const exported = await request(`/api/account/export?token=${encodeURIComponent(token)}`, {});
      const sealed = await codec.sealAccountExport(await exported.blob(), password);
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
    if (failure instanceof SealedFileError) return t`Wrong password, or the file is damaged`;
    if (failure instanceof Unreachable) return t`Could not reach the server`;
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
              disabled={save.pending || password.length < MIN_PASSWORD_LENGTH}
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
