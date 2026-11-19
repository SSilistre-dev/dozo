import { Trans, useLingui } from "@lingui/react/macro";
import { MESSAGING_EMAIL_SUFFIX } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { authClient } from "../lib/auth";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { toastError } from "../lib/dozo-error-text";
import { useSave } from "../lib/query";
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
  const [dismissed, setDismissed] = useState(() => readDismissed());
  const [sent, setSent] = useState(false);
  const unverified = Boolean(
    user && !user.emailVerified && !user.email.endsWith(MESSAGING_EMAIL_SUFFIX),
  );
  // Only a server that sends mail can verify an address; a failed read shows nothing.
  const capabilities = useQuery({
    queryKey: ["auth-capabilities"],
    queryFn: fetchAuthCapabilities,
    enabled: unverified,
  });
  const resend = useSave<string>({
    save: async (email) => {
      const result = await authClient.sendVerificationEmail({ email });
      if (result.error) throw Object.assign(new Error("send failed"), { body: result.error });
    },
    onSaved: () => setSent(true),
    onFailed: (error) => {
      const body = (error as Error & { body?: unknown }).body;
      if (body) toastError(authErrorText(body, t`Could not send the link`));
      else toastError(t`Could not send the link`, error);
    },
  });
  if (!user || !unverified || capabilities.data?.emailCode !== true || dismissed === user.id)
    return null;

  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-3 border-t bg-muted px-4 py-1.5 text-body-sm"
    >
      <span className="truncate text-muted-foreground">
        {sent ? <Trans>Link sent</Trans> : <Trans>Verify your email</Trans>}
      </span>
      {sent ? null : (
        <Button
          size="xs"
          variant="outline"
          disabled={resend.pending}
          onClick={() => resend.run(user.email)}
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
