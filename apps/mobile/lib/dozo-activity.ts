import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { AuditEventPage } from "@rakazo/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { queryClient, rpcQuery } from "./query/query";

const PAGE_SIZE = 30;

// The same words as the web app's activity log (`dozo-activity-log.tsx`), so both read alike and
// share their catalog lines.
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
 * The organization's activity log, newest first, a page at a time. The server decides who may read
 * it (owners and admins); for anyone else the read fails and nothing offers it.
 */
export function useDozoActivity() {
  const first = rpcQuery("audit/events", { limit: PAGE_SIZE });
  return useInfiniteQuery(
    {
      queryKey: first.queryKey,
      queryFn: (context) =>
        rpcQuery("audit/events", {
          limit: PAGE_SIZE,
          ...(context.pageParam ? { cursor: context.pageParam } : {}),
        }).queryFn(context as never) as Promise<AuditEventPage>,
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page: AuditEventPage) => page.nextCursor ?? undefined,
      refetchOnMount: "always",
    },
    queryClient,
  );
}
