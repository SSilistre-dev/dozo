import { Trans, useLingui } from "@lingui/react/macro";
import { Button, buttonVariants, Input, Label } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { errorText } from "../lib/dozo-error-text";
import { authErrorText } from "../lib/user-error";
import { AuthFrame, submitClass, PasswordResetPage as UpstreamPasswordResetPage } from "./Auth";

/**
 * Where an emailed link lands once the server has checked it. The verification link comes back
 * to `/verify-email` with the address and, when it did not verify, the auth library's `error`
 * code; a broken password reset link comes back to `/reset-password` with `error`. Each outcome
 * gets one short screen. The parameters leave the address bar at once and move into the history
 * entry, so a reload shows the same screen.
 */
export type LinkOutcome = "verified" | "expired" | "invalid" | "unknown";

/** Every code the verify-email endpoint redirects with, and the screen it gets. */
export function verifyOutcome(error: string | null | undefined): LinkOutcome {
  switch (error) {
    case null:
    case undefined:
    case "":
      return "verified";
    case "TOKEN_EXPIRED":
      return "expired";
    case "INVALID_TOKEN":
    case "USER_NOT_FOUND":
    case "INVALID_USER":
      return "invalid";
    default:
      return "unknown";
  }
}

type LinkState = { error: string | null; email: string };

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; to: string }
  | { kind: "failed"; message: string };

/** The link's parameters, taken out of the address once and kept in the history entry. */
function useLinkState(): LinkState | null {
  const [params] = useSearchParams();
  const { pathname, state: stored } = useLocation();
  const navigate = useNavigate();
  const fromParams = params.has("error") || params.has("email");
  const error = params.get("error");
  const email = params.get("email") ?? "";
  useEffect(() => {
    if (fromParams) navigate(pathname, { replace: true, state: { error, email } });
  }, [fromParams, error, email, pathname, navigate]);
  if (fromParams) return { error, email };
  const kept = stored as Partial<LinkState> | null;
  return kept && "error" in kept ? { error: kept.error ?? null, email: kept.email ?? "" } : null;
}

export function VerifyEmailPage() {
  const state = useLinkState();
  const session = authClient.useSession();
  if (!state) return <Navigate to="/" replace />;
  // The buttons depend on whether someone is signed in; wait for that instead of flashing.
  if (session.isPending) return <div className="h-full bg-background" />;
  return (
    <VerifyEmailResult
      outcome={verifyOutcome(state.error)}
      email={state.email}
      signedInEmail={session.data?.user.email ?? null}
    />
  );
}

export function VerifyEmailResult({
  outcome,
  email,
  signedInEmail,
}: {
  outcome: LinkOutcome;
  email: string;
  signedInEmail: string | null;
}) {
  const signedIn = signedInEmail !== null;
  // Onward: into the app when signed in, else to sign-in with the address filled in.
  const to = signedIn
    ? "/app"
    : email
      ? `/sign-in/email?email=${encodeURIComponent(email)}`
      : "/sign-in";
  const label =
    signedIn || outcome === "verified" ? <Trans>Continue</Trans> : <Trans>Sign in</Trans>;
  if (outcome === "verified") {
    return (
      <LinkResult title={<Trans>Email verified</Trans>}>
        <OnwardLink to={to} primary>
          {label}
        </OnwardLink>
      </LinkResult>
    );
  }
  if (outcome === "expired") {
    return (
      <ExpiredLink
        email={signedInEmail ?? email}
        signedIn={signedIn}
        onward={<OnwardLink to={to}>{label}</OnwardLink>}
      />
    );
  }
  return (
    <LinkResult
      title={
        outcome === "invalid" ? (
          <Trans>This link is no longer valid</Trans>
        ) : (
          <Trans>Could not open this link</Trans>
        )
      }
    >
      <OnwardLink to={to} primary>
        {label}
      </OnwardLink>
    </LinkResult>
  );
}

function ExpiredLink({
  email: initialEmail,
  signedIn,
  onward,
}: {
  email: string;
  signedIn: boolean;
  onward: ReactNode;
}) {
  const { t } = useLingui();
  const [email, setEmail] = useState(initialEmail);
  const [canSend, setCanSend] = useState(false);
  // One request at a time; its answer replaces the form, or says why it failed.
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  useEffect(() => {
    let active = true;
    // Only a server that sends mail can send a new link.
    fetchAuthCapabilities().then(
      (capabilities) => {
        if (active) setCanSend(capabilities.emailCode === true);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (send.kind === "sending" || !address) return;
    setSend({ kind: "sending" });
    try {
      const result = await authClient.sendVerificationEmail({ email: address });
      setSend(
        result.error
          ? { kind: "failed", message: authErrorText(result.error, t`Could not send the link`) }
          : { kind: "sent", to: address },
      );
    } catch (failure) {
      setSend({ kind: "failed", message: errorText(failure, t`Could not send the link`) });
    }
  }

  return (
    <LinkResult title={<Trans>This link has expired</Trans>} onSubmit={submit}>
      {send.kind === "sent" ? (
        <Sent to={send.to} />
      ) : canSend ? (
        <>
          {signedIn ? null : (
            <div className="w-full">
              <Label htmlFor="email" className="text-muted-foreground">
                <Trans>Email</Trans>
              </Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t`Your email address`}
                className="mt-2 h-12 rounded-xl px-4 text-[16px]/6 md:text-body-lg"
              />
            </div>
          )}
          {send.kind === "failed" ? (
            <p role="alert" className="mt-3 w-full text-body text-destructive">
              {send.message}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={send.kind === "sending"}
            className={submitClass}
          >
            <Trans>Send a new link</Trans>
          </Button>
        </>
      ) : null}
      <div className="mt-6">{onward}</div>
    </LinkResult>
  );
}

function Sent({ to }: { to: string }) {
  return (
    <p role="status" className="w-full text-center text-body text-muted-foreground">
      <Trans>We sent a new link to {to}.</Trans>
    </p>
  );
}

/**
 * Upstream's reset page for a link that still holds a token. A broken one (the server found it
 * invalid or expired, which it does not tell apart, or it has no token) gets the same screen as a
 * verification link that no longer works, with the way to ask for a new one.
 */
export function PasswordResetPage() {
  const [params] = useSearchParams();
  const state = useLinkState();
  if (!state && params.get("token")) return <UpstreamPasswordResetPage />;
  return (
    <LinkResult title={<Trans>This link is no longer valid</Trans>}>
      <OnwardLink to="/forgot-password" primary>
        <Trans>Request a new link</Trans>
      </OnwardLink>
      <div className="mt-6">
        <OnwardLink to="/sign-in">
          <Trans>Back to sign in</Trans>
        </OnwardLink>
      </div>
    </LinkResult>
  );
}

function LinkResult({
  title,
  onSubmit = (event) => event.preventDefault(),
  children,
}: {
  title: ReactNode;
  onSubmit?: (event: React.FormEvent) => void;
  children: ReactNode;
}) {
  return (
    <AuthFrame title={title} onSubmit={onSubmit}>
      {children}
    </AuthFrame>
  );
}

function OnwardLink({
  to,
  primary = false,
  children,
}: {
  to: string;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={primary ? buttonVariants({ size: "lg", className: submitClass }) : "font-medium"}
    >
      {children}
    </Link>
  );
}
