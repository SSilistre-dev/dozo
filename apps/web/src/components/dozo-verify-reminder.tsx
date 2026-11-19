import { Trans, useLingui } from "@lingui/react/macro";
import { MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { authClient } from "../lib/auth";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { toastError } from "../lib/dozo-error-text";
import { authErrorText } from "../lib/user-error";

const DISMISSED_KEY = "dozo:verify-reminder-dismissed";

/**
 * One line, below the signed-in pages, while the account's address is not verified and the server
 * sends mail (without mail nothing could verify it). Verifying stays optional. "Resend" mails a new
 * link; closing the line hides it for this tab and account. The session is read again whenever the
 * window comes back (the auth client does that on focus), so the line goes once the link is opened.
 */
export function DozoVerifyReminder() {
  const { t } = useLingui();
  const session = authClient.useSession();
  const user = session.data?.user;
  const [mailing, setMailing] = useState(false);
  const [dismissed, setDismissed] = useState(() => readDismissed());
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const unverified = Boolean(
    user && !user.emailVerified && !user.email.endsWith(MESSAGING_EMAIL_SUFFIX),
  );
  useEffect(() => {
    if (!unverified) return;
    let active = true;
    fetchAuthCapabilities().then(
      (capabilities) => {
        if (active) setMailing(capabilities.emailCode === true);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [unverified]);
  if (!user || !unverified || !mailing || dismissed === user.id) return null;

  const resend = async () => {
    setState("sending");
    try {
      const result = await authClient.sendVerificationEmail({ email: user.email });
      if (result.error) {
        toastError(authErrorText(result.error, t`Could not send the link`));
        setState("idle");
      } else setState("sent");
    } catch (error) {
      toastError(t`Could not send the link`, error);
      setState("idle");
    }
  };
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-3 border-t bg-muted px-4 py-1.5 text-body-sm"
    >
      <span className="truncate text-muted-foreground">
        {state === "sent" ? <Trans>Link sent</Trans> : <Trans>Verify your email</Trans>}
      </span>
      {state === "sent" ? null : (
        <Button
          size="xs"
          variant="outline"
          disabled={state === "sending"}
          onClick={() => void resend()}
        >
          <Trans>Resend</Trans>
        </Button>
      )}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t`Dismiss`}
        onClick={() => {
          writeDismissed(user.id);
          setDismissed(user.id);
        }}
      >
        <X />
      </Button>
    </div>
  );
}

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(userId: string) {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, userId);
  } catch {
    // Without storage the line stays hidden for as long as this page is open.
  }
}
