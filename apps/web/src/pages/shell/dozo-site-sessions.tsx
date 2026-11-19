import { Trans, useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { ComputerStatus } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, X } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { errorText } from "../../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../../lib/query";
import { formatRelativeTime } from "../../lib/relative-time";

/**
 * The browser saves new cookies to disk about every 30 seconds, and only the disk knows their
 * times: a list read right after a sign-in shows "just now" and is read once more after this.
 */
const UNSAVED_REREAD_MS = 35_000;

/** One site, or every site when null. */
type Ending = { site: string | null };

/**
 * The sites this bot's browser holds cookies for, from the computer's header: open one to sign in
 * with control, or sign the bot out of one or all. Shown only on a running computer whose
 * provider can read its browser's sessions.
 */
export function SiteSessionsControl({
  botId,
  computer,
  onSignedIn,
}: {
  botId: string;
  computer: ComputerStatus | null;
  /** Shows the screen with the control the server just gave this person. */
  onSignedIn: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  if (computer?.botId !== botId || computer.state !== "running" || !computer.siteSessions)
    return null;
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        aria-label={t`Sites with cookies`}
        data-testid="computer-site-sessions"
        onClick={() => setOpen(true)}
      >
        <KeyRound size={16} strokeWidth={1.8} />
      </Button>
      {open ? (
        <SiteSessionsDialog
          botId={botId}
          shared={Boolean(computer.shared)}
          onClose={() => setOpen(false)}
          onSignedIn={() => {
            setOpen(false);
            onSignedIn();
          }}
        />
      ) : null}
    </>
  );
}

function SiteSessionsDialog({
  botId,
  shared,
  onClose,
  onSignedIn,
}: {
  botId: string;
  shared: boolean;
  onClose: () => void;
  onSignedIn: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [address, setAddress] = useState("");
  const [ending, setEnding] = useState<Ending | null>(null);
  const sites = useQuery({
    ...queries.dozoSiteSessions.list.queryOptions({ input: { botId } }),
    refetchOnWindowFocus: "always",
  });
  const signIn = useSave({
    save: (url: string, rpc) => rpc.dozoSiteSessions.signIn({ botId, url }),
    onSaved: onSignedIn,
  });
  const signOut = useSave({
    save: ({ site }: Ending, rpc) =>
      rpc.dozoSiteSessions.signOut({ botId, ...(site ? { site } : {}) }),
    stale: [queries.dozoSiteSessions.list.key({ input: { botId } })],
    onSaved: () => setEnding(null),
    // Some sites may be gone even so: the list read again shows which are left.
    onFailed: () => void sites.refetch(),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (address.trim()) signIn.run(address.trim());
  };
  const list = sites.data?.sites ?? [];
  // One read again, never a poll: the times are on disk by then.
  const [reread, setReread] = useState(false);
  useTimeout(
    () => {
      setReread(true);
      void sites.refetch();
    },
    !reread && list.some(({ lastUsedAt }) => lastUsedAt === null) ? UNSAVED_REREAD_MS : null,
  );
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Sites with cookies</Trans>
          </DialogTitle>
        </DialogHeader>
        {/* The dialog's own close button names itself in English only. */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-4.5 right-4.5"
          aria-label={t`Close`}
          onClick={onClose}
        >
          <X />
        </Button>
        <form onSubmit={submit} className="flex gap-2">
          <Input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="example.com"
            aria-label={t`Site to sign in to`}
            autoComplete="off"
            spellCheck={false}
            disabled={signIn.pending}
          />
          <Button type="submit" disabled={signIn.pending || !address.trim()}>
            <Trans>Sign in</Trans>
          </Button>
        </form>
        <p className="text-body-sm text-muted-foreground">
          <Trans>The bot can act as you on these sites, and a page it reads can steer it.</Trans>
        </p>
        {shared ? (
          <p className="text-body-sm text-muted-foreground">
            <Trans>Sites you sign in to stay signed in for everyone in this space</Trans>
          </p>
        ) : null}
        {signIn.error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {errorText(signIn.error, t`Could not take control`)}
          </p>
        ) : null}
        {sites.isPending ? (
          <div className="grid place-items-center py-6">
            <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
          </div>
        ) : sites.isError ? (
          <div role="alert" className="flex items-center gap-3 text-body-sm text-destructive">
            {errorText(sites.error)}
            <Button variant="outline" size="sm" onClick={() => void sites.refetch()}>
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : list.length ? (
          <ul className="max-h-80 overflow-y-auto" data-testid="site-sessions-list">
            {list.map((entry) => (
              <li
                key={entry.site}
                className="flex min-h-11 items-center justify-between gap-3 border-b last:border-b-0"
              >
                <span className="min-w-0 truncate text-body">{entry.site}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-body-sm text-muted-foreground">
                    {entry.lastUsedAt ? formatRelativeTime(entry.lastUsedAt) : t`just now`}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t`Sign out of ${entry.site}`}
                    onClick={() => setEnding({ site: entry.site })}
                  >
                    <Trans>Sign out</Trans>
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-4 text-center text-body-sm text-muted-foreground">
            <Trans>No sites yet</Trans>
          </p>
        )}
        {list.length > 1 ? (
          <Button variant="outline" className="self-end" onClick={() => setEnding({ site: null })}>
            <Trans>Sign out of all</Trans>
          </Button>
        ) : null}
      </DialogContent>
      {ending ? (
        <ConfirmDialog
          title={
            ending.site ? (
              <Trans>Sign out of {ending.site}?</Trans>
            ) : (
              <Trans>Sign out of all sites?</Trans>
            )
          }
          confirmLabel={<Trans>Sign out</Trans>}
          busy={signOut.pending}
          error={signOut.error ? errorText(signOut.error) : null}
          onCancel={() => {
            signOut.reset();
            setEnding(null);
          }}
          onConfirm={() => signOut.run(ending)}
        />
      ) : null}
    </Dialog>
  );
}
