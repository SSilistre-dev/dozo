import { Trans, useLingui } from "@lingui/react/macro";
import { authErrorText } from "@rakazo/i18n/user-error";
import { Button, buttonVariants, Input, Label } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth/auth";
import { fetchAuthCapabilities } from "../lib/auth/auth-capabilities";
import { getActiveUiLocale } from "../lib/locale/i18n";
import type { UiLocale } from "../lib/locale/ui-locale";
import { useSave } from "../lib/query/query";
import {
  AuthFrame,
  submitClass,
  PasswordResetPage as UpstreamPasswordResetPage,
} from "./auth/Auth";
import { AuthLocaleSelect } from "./dozo-auth-locale";

/**
 * Where an emailed link lands once the server has checked it. The verification link comes back
 * to `/verify-email` with `v`, a mark the server signed for the account, and, when it did not
 * verify, the auth library's `error` code; a broken password reset link comes back to
 * `/reset-password` with `error`. Each outcome gets one short screen. The parameters leave the
 * address bar at once and move into the history entry, so a reload shows the same screen.
 *
 * "Verified" is said only when the server confirms it: for the account the mark names
 * (`/api/auth/dozo/email-link`, packages/auth/src/dozo-email-link.ts), or for the signed-in
 * account. An address with no error and nothing the server confirms gets a neutral screen, so a
 * hand-made link cannot claim a verification. No address travels in a URL: the form is filled
 * from the server's answer and handed to sign-in in the history entry.
 */
type LinkOutcome = "verified" | "expired" | "invalid" | "unknown" | "neutral";

/** Every code the verify-email endpoint redirects with, and the screen it gets. */
export function errorOutcome(error: string): Exclude<LinkOutcome, "verified" | "neutral"> {
  switch (error) {
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

type LinkState = { error: string | null; mark: string };
type MarkAnswer = { verified: boolean; email: string | null };

/** The link's parameters, taken out of the address once and kept in the history entry. */
function useLinkState(): LinkState | null {
  const [params] = useSearchParams();
  const { pathname, state: stored } = useLocation();
  const navigate = useNavigate();
  const fromParams = params.has("error") || params.has("v");
  const error = params.get("error");
  const mark = params.get("v") ?? "";
  useEffect(() => {
    if (fromParams) navigate(pathname, { replace: true, state: { error, mark } });
  }, [fromParams, error, mark, pathname, navigate]);
  if (fromParams) return { error, mark };
  const kept = stored as Partial<LinkState> | null;
  return kept && "error" in kept ? { error: kept.error ?? null, mark: kept.mark ?? "" } : null;
}

async function readMark(mark: string): Promise<MarkAnswer> {
  const response = await fetch(`/api/auth/dozo/email-link?v=${encodeURIComponent(mark)}`);
  if (!response.ok) throw new Error(`email link answered ${response.status}`);
  return (await response.json()) as MarkAnswer;
}

export function VerifyEmailPage() {
  const state = useLinkState();
  const session = authClient.useSession();
  const mark = state?.mark ?? "";
  const answer = useQuery({
    queryKey: ["dozo-email-link", mark],
    queryFn: () => readMark(mark),
    enabled: Boolean(mark),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!state) return <Navigate to="/" replace />;
  // The buttons depend on who is signed in and what the server says; wait instead of flashing.
  if (session.isPending || answer.isLoading) return <div className="h-full bg-background" />;
  const user = session.data?.user ?? null;
  const confirmed = answer.data?.verified === true || user?.emailVerified === true;
  const outcome: LinkOutcome = state.error
    ? errorOutcome(state.error)
    : confirmed
      ? "verified"
      : "neutral";
  return (
    <VerifyEmailResult
      outcome={outcome}
      email={answer.data?.email ?? ""}
      signedInEmail={user?.email ?? null}
    />
  );
}

function VerifyEmailResult({
  outcome,
  email,
  signedInEmail,
}: {
  outcome: LinkOutcome;
  email: string;
  signedInEmail: string | null;
}) {
  const signedIn = signedInEmail !== null;
  // Onward: into the app when signed in, else to sign-in with the address filled in. Signed out,
  // the button says where it goes, also after "verified".
  const onward = (primary: boolean) =>
    signedIn ? (
      <OnwardLink to="/app" primary={primary}>
        <Trans>Continue</Trans>
      </OnwardLink>
    ) : (
      <OnwardLink to="/sign-in/email" state={email ? { email } : undefined} primary={primary}>
        <Trans>Sign in</Trans>
      </OnwardLink>
    );
  if (outcome === "expired") {
    return (
      <ExpiredLink email={signedInEmail ?? email} signedIn={signedIn} onward={onward(false)} />
    );
  }
  const title =
    outcome === "verified" ? (
      <Trans>Email verified</Trans>
    ) : outcome === "invalid" ? (
      <Trans>This link is no longer valid</Trans>
    ) : outcome === "unknown" ? (
      <Trans>Could not open this link</Trans>
    ) : signedIn ? (
      <Trans>Continue to Dozo</Trans>
    ) : (
      <Trans>Sign in to continue</Trans>
    );
  const openApp = (outcome === "verified" || outcome === "neutral") && onPhone();
  return (
    <LinkResult title={title} address={outcome === "verified" ? email || signedInEmail : null}>
      {onward(true)}
      {openApp ? (
        <div className="mt-6">
          {/* The app's own scheme (apps/mobile `scheme`): the mail opened in the phone's browser. */}
          <a href="dozo://" className="font-medium">
            <Trans>Open Dozo</Trans>
          </a>
        </div>
      ) : null}
    </LinkResult>
  );
}

/** A mailed link opens in the phone's browser, which cannot hand the person back to the app. */
const onPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

/** An error from the auth client, kept with its code so the shared copy can name it. */
class AuthCallError extends Error {
  constructor(readonly body: { code?: string; status?: number; message?: string }) {
    super(body.message ?? body.code ?? "auth call failed");
  }
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
  const [sentTo, setSentTo] = useState<string | null>(null);
  // Only a server that sends mail can send a new link; a failed read shows no button.
  const capabilities = useQuery({
    queryKey: ["auth-capabilities"],
    queryFn: fetchAuthCapabilities,
  });
  const send = useSave<string>({
    save: async (address) => {
      const result = await authClient.sendVerificationEmail({ email: address });
      if (result.error) throw new AuthCallError(result.error);
    },
    onSaved: (_saved, address) => setSentTo(address),
  });
  const failure = send.error
    ? authErrorText(
        send.error instanceof AuthCallError ? send.error.body : send.error,
        t`Could not send the link`,
      )
    : null;

  return (
    <LinkResult
      title={<Trans>This link has expired</Trans>}
      onSubmit={(event) => {
        event.preventDefault();
        const address = email.trim();
        if (address) send.run(address);
      }}
    >
      {sentTo ? (
        <Sent to={sentTo} />
      ) : capabilities.data?.emailCode === true ? (
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
                // off-scale: 16px below md stops iOS Safari zooming into a focused field.
                size="xl"
                className="mt-2 text-[16px]/6"
              />
            </div>
          )}
          {failure ? (
            <p role="alert" className="mt-3 w-full text-body text-destructive">
              {failure}
            </p>
          ) : null}
          <Button type="submit" size="lg" disabled={send.pending} className={submitClass}>
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
  const [locale, setLocale] = useState<UiLocale>(getActiveUiLocale);
  if (!state && params.get("token"))
    return (
      <>
        <UpstreamPasswordResetPage />
        <AuthLocaleSelect locale={locale} onChange={setLocale} />
      </>
    );
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

export function LinkResult({
  title,
  address = null,
  detail = null,
  onSubmit = (event) => event.preventDefault(),
  children,
}: {
  title: ReactNode;
  address?: string | null;
  detail?: string | null;
  onSubmit?: (event: React.FormEvent) => void;
  children: ReactNode;
}) {
  const [locale, setLocale] = useState<UiLocale>(getActiveUiLocale);
  return (
    <>
      <AuthFrame title={title} onSubmit={onSubmit}>
        {address ? (
          <p data-dozo-auth-address className="w-full text-center text-muted-foreground">
            {address}
          </p>
        ) : null}
        {detail ? (
          <p className="mb-6 w-full text-center text-body text-muted-foreground">{detail}</p>
        ) : null}
        {children}
      </AuthFrame>
      <AuthLocaleSelect locale={locale} onChange={setLocale} />
    </>
  );
}

export function OnwardLink({
  to,
  state,
  primary = false,
  children,
}: {
  to: string;
  state?: { email: string };
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      state={state}
      data-dozo-onward={primary || undefined}
      className={primary ? buttonVariants({ size: "lg", className: "px-10" }) : "font-medium"}
    >
      {children}
    </Link>
  );
}
