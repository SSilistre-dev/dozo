import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoClientDiagnostics, DozoFeedbackStatus } from "@rakazo/contracts";
import { DOZO_FEEDBACK_MAX_CHARS, dozoFeedbackFooter, dozoFeedbackText } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Disclosure,
  Switch,
  Textarea,
  toast,
} from "@rakazo/ui-web";
import { useId, useState } from "react";
import { downloadArtifactBytes } from "../lib/artifact-open";
import { desktopBridge } from "../lib/desktop";
import { errorText } from "../lib/dozo-error-text";
import { useSave } from "../lib/query";
import { useFeedbackStatus } from "./dozo-feedback";

/** What the app says about itself: surface, browser, language and time zone, nothing else. */
export function clientDiagnostics(view: Window = window): DozoClientDiagnostics {
  return {
    surface: desktopBridge() ? "desktop" : "web",
    userAgent: view.navigator.userAgent.slice(0, 300),
    language: view.navigator.language.slice(0, 35),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone.slice(0, 64),
  };
}

/**
 * A note and, when switched on, the diagnostics. The lines added under the note are shown before
 * anything leaves: the server mails exactly those, or, without mail, the person saves the report
 * and writes to the operator's address themselves.
 */
export function DozoFeedbackDialog({ onClose }: { onClose: () => void }) {
  const status = useFeedbackStatus();
  if (!status?.mode) return null;
  return <FeedbackForm status={status} onClose={onClose} />;
}

function FeedbackForm({ status, onClose }: { status: DozoFeedbackStatus; onClose: () => void }) {
  const { t } = useLingui();
  const switchId = useId();
  const [message, setMessage] = useState("");
  const [withDiagnostics, setWithDiagnostics] = useState(false);
  const [client] = useState(clientDiagnostics);
  const diagnostics = withDiagnostics ? { ...client, ...status.server } : null;
  const save = useSave({
    save: (_input, rpc) =>
      rpc.dozoFeedback.send({
        message,
        ...(withDiagnostics
          ? { diagnostics: { client, runIds: status.server.failedRuns.map((run) => run.id) } }
          : {}),
      }),
    onSaved: () => {
      toast(t`Sent`);
      onClose();
    },
    closesScreen: true,
  });
  const empty = !message.trim();

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent data-testid="dozo-feedback">
        <DialogHeader>
          <DialogTitle>
            <Trans>Send feedback</Trans>
          </DialogTitle>
        </DialogHeader>
        <Textarea
          aria-label={t`Feedback`}
          placeholder={t`What happened?`}
          rows={5}
          maxLength={DOZO_FEEDBACK_MAX_CHARS}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <label htmlFor={switchId} className="flex items-center gap-2.5 text-body">
          <Switch id={switchId} checked={withDiagnostics} onCheckedChange={setWithDiagnostics} />
          <Trans>Include diagnostics</Trans>
        </label>
        <Disclosure
          summary={<Trans>What's sent</Trans>}
          summaryClassName="text-body-sm text-muted-foreground"
        >
          <pre
            data-testid="dozo-feedback-preview"
            className="mt-2 max-h-40 overflow-auto rounded-md bg-muted p-2.5 text-label whitespace-pre-wrap break-all text-muted-foreground"
          >
            {dozoFeedbackFooter(status.from, diagnostics)}
          </pre>
        </Disclosure>
        {save.error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {errorText(save.error, t`Could not send`)}
          </p>
        ) : null}
        <DialogFooter>
          {status.mode === "send" ? (
            <Button disabled={empty || save.pending} onClick={() => save.run()}>
              <Trans>Send</Trans>
            </Button>
          ) : (
            <>
              <p className="me-auto self-center text-body-sm text-muted-foreground">
                <a className="underline" href={`mailto:${status.address}`}>
                  {status.address}
                </a>
              </p>
              <Button
                disabled={empty}
                onClick={() =>
                  downloadArtifactBytes(
                    "feedback.txt",
                    "text/plain",
                    new TextEncoder().encode(dozoFeedbackText(message, status.from, diagnostics)),
                  )
                }
              >
                <Trans>Save</Trans>
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
