import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { lazy, Suspense, useSyncExternalStore } from "react";
import { useSpaceQueries } from "../lib/query/query";

const DozoFeedbackDialog = lazy(() =>
  import("./dozo-feedback-dialog").then((module) => ({ default: module.DozoFeedbackDialog })),
);

// The menu item lives in the account popover, which unmounts as it closes, so the dialog is held
// by a host outside it and opened through this one flag.
let open = false;
const listeners = new Set<() => void>();
function setOpen(next: boolean) {
  open = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Where feedback goes on this server; nothing while it is loading or not set up. */
export function useFeedbackStatus() {
  const queries = useSpaceQueries();
  return useQuery(queries.dozoFeedback.status.queryOptions()).data;
}

/** The account menu's way to send feedback, shown only when the server takes it. */
export function DozoFeedbackItem({ onOpen }: { onOpen: () => void }) {
  const status = useFeedbackStatus();
  if (!status?.mode) return null;
  return (
    <Button
      variant="ghost"
      size="lg"
      className="w-full justify-start gap-2.5 font-normal"
      onClick={() => {
        onOpen();
        setOpen(true);
      }}
    >
      <MessageSquare className="text-muted-foreground" strokeWidth={1.75} />
      <Trans>Send feedback</Trans>
    </Button>
  );
}

/** Holds the feedback dialog; its code loads the first time it opens. */
export function DozoFeedbackHost() {
  const isOpen = useSyncExternalStore(subscribe, () => open);
  if (!isOpen) return null;
  return (
    <Suspense fallback={null}>
      <DozoFeedbackDialog onClose={() => setOpen(false)} />
    </Suspense>
  );
}
