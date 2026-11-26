import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { AuditEvent } from "@rakazo/contracts";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Spinner } from "@rakazo/ui-web";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { queryClient, useSpaceQueries } from "../lib/query/query";
import { SettingsRow } from "./settings/SettingsRows";

const PAGE_SIZE = 30;

/** What happened, in words; the actor is shown beside it. */
const ACTION_LABELS: Record<string, MessageDescriptor> = {
  "tool.call": msg`Used a tool`,
  "credential.used": msg`Used a vault item`,
  "credential.created": msg`Added a credential`,
  "credential.changed": msg`Changed a credential`,
  "credential.deleted": msg`Removed a credential`,
  "credential.revealed": msg`Revealed a credential`,
  "approval.decided": msg`Answered an approval`,
  "approval.auto_reviewed": msg`Reviewed automatically`,
  "approval.policy.changed": msg`Changed approvals`,
  "auth.sign_in": msg`Signed in`,
  "auth.sign_out": msg`Signed out`,
  "auth.password.changed": msg`Changed the password`,
  "auth.session.revoked": msg`Ended a session`,
  "audit_log.exported": msg`Exported the activity log`,
};

/** Families named once for all their actions. */
const ACTION_FAMILY_LABELS: [prefix: string, label: MessageDescriptor][] = [
  ["auth.passkey.", msg`Changed passkeys`],
  ["device.", msg`Changed devices`],
  ["space.", msg`Changed a space`],
];

/** The words for an action, or null for one this list does not know (it shows its stable name). */
export function dozoActivityAction(action: string): MessageDescriptor | null {
  return (
    ACTION_LABELS[action] ??
    ACTION_FAMILY_LABELS.find(([prefix]) => action.startsWith(prefix))?.[1] ??
    null
  );
}

/**
 * The organization's activity log, from Settings > General > Security. The server decides who may
 * read it (owners and admins, as for the export); anyone else never sees the row. It shows what the
 * export shows minus client addresses, user agents and details: no secret or message content is in
 * the log at all. Read when settings open and again when the window regains focus.
 */
export function DozoActivityLogRow() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const queries = useSpaceQueries();
  const log = useInfiniteQuery(
    queries.audit.events.infiniteOptions({
      input: (cursor: string | undefined) => ({ cursor, limit: PAGE_SIZE }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      refetchOnWindowFocus: "always",
    }),
    // Named, so the row also renders where settings are shown without a query provider.
    queryClient,
  );
  // Pending, or refused: someone who may not read the log is not offered it.
  if (!log.data) return null;
  const events = log.data.pages.flatMap((page) => page.events);
  return (
    <>
      <SettingsRow
        label={<Trans>Activity</Trans>}
        control={
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            <Trans>View</Trans>
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-testid="dozo-activity-log"
          className="max-h-[calc(100%-4rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Activity</Trans>
            </DialogTitle>
          </DialogHeader>
          <div className="-mx-6 min-h-0 overflow-y-auto px-6">
            {events.length === 0 ? (
              <p className="py-2 text-body text-muted-foreground">
                <Trans>No activity yet</Trans>
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {events.map((event) => (
                  <ActivityRow key={event.id} event={event} />
                ))}
              </ul>
            )}
            {log.isFetchNextPageError ? (
              <p role="alert" className="py-2 text-body-sm text-destructive">
                <Trans>Couldn't load more</Trans>
              </p>
            ) : null}
            {log.hasNextPage ? (
              <Button
                variant="text"
                disabled={log.isFetchingNextPage}
                onClick={() => void log.fetchNextPage()}
                className="mt-1 font-normal"
              >
                {log.isFetchingNextPage ? <Spinner aria-label={t`Loading…`} /> : null}
                <Trans>Load older</Trans>
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ActivityRow({ event }: { event: AuditEvent }) {
  const { t, i18n } = useLingui();
  const at = new Date(event.createdAt);
  const action = dozoActivityAction(event.action);
  const details = [
    { key: "actor", text: event.actorLabel },
    { key: "space", text: event.spaceName },
    {
      key: "outcome",
      text: { success: null, denied: t`Denied`, failure: t`Failed` }[event.outcome],
      tone: "text-destructive",
    },
  ].filter((detail): detail is { key: string; text: string; tone?: string } =>
    Boolean(detail.text),
  );
  return (
    <li data-testid="dozo-activity-row" className="py-2.5 text-body">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 break-words text-foreground">
          {action ? i18n._(action) : event.action}
          {event.targetLabel ? (
            <span className="text-muted-foreground"> {event.targetLabel}</span>
          ) : null}
        </p>
        <time
          dateTime={event.createdAt}
          className="shrink-0 text-body-sm tabular-nums text-muted-foreground"
        >
          {at.toLocaleString(i18n.locale, { dateStyle: "medium", timeStyle: "short" })}
        </time>
      </div>
      {details.length > 0 ? (
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-body-sm text-muted-foreground">
          {details.map(({ key, text, tone }) => (
            <span key={key} className={`min-w-0 break-words ${tone ?? ""}`}>
              {text}
            </span>
          ))}
        </p>
      ) : null}
    </li>
  );
}
