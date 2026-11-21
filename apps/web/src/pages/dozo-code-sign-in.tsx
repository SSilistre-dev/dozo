import { Trans, useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import type { SignInProvider } from "@rakazo/contracts";
import { credentialIssue } from "@rakazo/core";
import { Button, Input, InputOTP, InputOTPGroup, InputOTPSlot, Label } from "@rakazo/ui-web";
import { useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { usePasskeySignIn } from "../components/PasskeySignIn";
import { SocialSignInButtons } from "../components/SocialSignInButtons";
import { authClient } from "../lib/auth";
import { clearSpaceSelection } from "../lib/rpc";
import { newAccountDestination, signInNext } from "../lib/sign-in-next";
import { runSsoFlow } from "../lib/sso-flow";
import { authErrorText, credentialIssueText } from "../lib/user-error";
import { AuthFrame, submitClass } from "./Auth";
import { DozoSignupTerms } from "./dozo-signup-terms";

const CODE_LENGTH = 6;
/** How long "Resend code" waits after a code was sent; the server keeps its own limit. */
export const RESEND_AFTER_MS = 30_000;

/**
 * Email-first sign-in (dozo/design/signin-v2.html): an address, then the six-digit code the
 * server mails. It calls the same client functions as upstream's blank-password path
 * (`emailOtp.sendVerificationOtp`, `signIn.emailOtp`), so what the server decides is unchanged:
 * a known and an unknown address see the same steps, and an unknown one gets an account only
 * under the deployment's sign-up policy. A password is the way round: "Use a password instead"
 * opens upstream's own form at `/sign-in/email`, handing it the address in the history entry.
 * The deployment's providers and passkeys stay on the first step.
 */
export function DozoCodeSignIn({ providers }: { providers: SignInProvider[] }) {
  const { t } = useLingui();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = signInNext(searchParams.get("next"));
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : "";
  const [email, setEmail] = useState(() => {
    const handed = (location.state as { email?: unknown } | null)?.email;
    return typeof handed === "string" ? handed : "";
  });
  const [step, setStep] = useState<"email" | "code">("email");
  const [code, setCode] = useState("");
  const [sentAt, setSentAt] = useState(0);
  const [misses, setMisses] = useState(0);
  const [pending, setPending] = useState(false);
  const entering = useRef(false);
  const [error, setError] = useState<string | null>(() => {
    const failed = searchParams.get("error");
    return failed ? authErrorText({ code: failed }, t`Could not continue`) : null;
  });
  const emailIssue = error === credentialIssueText("email");
  const passkey = usePasskeySignIn({ onSignedIn: enterApp, onError: setError, autoFill: true });
  const waiting = sentAt > 0 && step === "code";
  const now = useNow(waiting ? 1000 : null);
  const left = waiting ? Math.max(0, Math.ceil((sentAt + RESEND_AFTER_MS - now) / 1000)) : 0;

  function enterApp() {
    clearSpaceSelection();
    // The routes move a signed-in user on once the session refetch lands.
    entering.current = true;
    setPending(true);
  }

  async function send(): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      const request = await authClient.emailOtp.sendVerificationOtp({
        email: email.trim(),
        type: "sign-in",
      });
      if (request.error) {
        setError(authErrorText(request.error, t`Could not continue`));
        return false;
      }
      setSentAt(Date.now());
      return true;
    } catch {
      setError(t`Could not reach the server`);
      return false;
    } finally {
      if (!entering.current) setPending(false);
    }
  }

  async function verify(otp: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await authClient.signIn.emailOtp({ email: email.trim(), otp });
      if (result.error) {
        setError(authErrorText(result.error, t`Could not continue`));
        setCode("");
        setMisses((count) => count + 1);
        return;
      }
      enterApp();
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      if (!entering.current) setPending(false);
    }
  }

  async function signInWithProvider(provider: string) {
    // The same flow as upstream's sign-in page.
    setError(null);
    try {
      const result = await runSsoFlow(
        (disableRedirect, callbackURL) =>
          authClient.signIn.social({
            disableRedirect,
            provider,
            newUserCallbackURL: callbackURL(newAccountDestination(next)),
            callbackURL: callbackURL(next ?? "/app"),
            errorCallbackURL: callbackURL("/sign-in"),
          }),
        ["/app", "/onboarding", "/integrations/setup", "/sign-in", ...(next ? [next] : [])],
      );
      if (result.error) setError(authErrorText(result.error, t`Could not continue`));
    } catch {
      setError(t`Could not continue`);
    }
  }

  if (step === "code") {
    return (
      <AuthFrame
        title={<Trans>Check your email</Trans>}
        onSubmit={(event) => {
          event.preventDefault();
          // An unfinished code would spend one of the code's three attempts.
          if (code.length === CODE_LENGTH) void verify(code);
        }}
      >
        <p data-dozo-auth-address className="w-full text-center text-muted-foreground">
          {email.trim()}
        </p>
        <div key={misses} data-dozo-code data-missed={misses > 0 || undefined}>
          <InputOTP
            aria-label={t({ message: "Code", context: "email sign-in" })}
            maxLength={CODE_LENGTH}
            pattern={"^\\d+$"}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            disabled={pending}
            value={code}
            onChange={(value: string) => {
              setCode(value);
              if (value) setError(null);
            }}
            onComplete={(value: string) => void verify(value)}
          >
            <InputOTPGroup>
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <InputOTPSlot key={index} index={index} />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
        {error ? (
          <p role="alert" data-dozo-auth-error className="w-full text-center text-destructive">
            {error}
          </p>
        ) : null}
        <div data-dozo-auth-row className="flex w-full justify-between">
          <button
            type="button"
            data-dozo-quiet
            disabled={pending && !entering.current}
            onClick={() => {
              setStep("email");
              setCode("");
              setError(null);
            }}
          >
            <Trans>Back</Trans>
          </button>
          <button
            type="button"
            data-dozo-quiet
            data-testid="resend-code"
            disabled={pending || left > 0}
            onClick={() => {
              setCode("");
              void send();
            }}
          >
            <Trans>Resend code</Trans>
            {left > 0 ? (
              <span data-dozo-auth-wait className="tabular-nums">
                {`0:${String(left).padStart(2, "0")}`}
              </span>
            ) : null}
          </button>
        </div>
        <DozoSignupTerms />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title={<Trans>Sign in to Rakazo</Trans>}
      onSubmit={(event) => {
        event.preventDefault();
        const issue = credentialIssue({ email });
        if (issue) {
          setError(credentialIssueText(issue));
          return;
        }
        void send().then((sent) => {
          if (!sent) return;
          setCode("");
          setMisses(0);
          setStep("code");
        });
      }}
    >
      <div className="w-full">
        <Label htmlFor="email" className="text-muted-foreground">
          <Trans>Email</Trans>
        </Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username webauthn"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={t`Your email address`}
          aria-invalid={emailIssue || undefined}
          aria-describedby={emailIssue ? "email-issue" : undefined}
        />
        {emailIssue ? (
          <p id="email-issue" role="alert" className="mt-2 text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      {error && !emailIssue ? (
        <p role="alert" className="mt-3 w-full text-body text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" disabled={pending} className={submitClass}>
        {pending ? <Trans>Working…</Trans> : <Trans>Continue</Trans>}
      </Button>
      {providers.length > 0 ? (
        <div data-dozo-auth-providers className="w-full">
          <SocialSignInButtons
            providers={providers}
            disabled={pending || passkey.pending}
            onPress={(providerId) => void signInWithProvider(providerId)}
          />
        </div>
      ) : null}
      <div data-dozo-auth-links className="flex flex-col items-center">
        {passkey.supported ? (
          <button
            type="button"
            data-dozo-quiet
            disabled={pending || passkey.pending}
            onClick={passkey.start}
          >
            <Trans>Continue with passkey</Trans>
          </button>
        ) : null}
        <button
          type="button"
          data-dozo-quiet
          data-testid="use-password"
          disabled={pending}
          onClick={() =>
            navigate(`/sign-in/email${location.search}`, { state: { email: email.trim() } })
          }
        >
          <Trans>Use a password instead</Trans>
        </button>
      </div>
      <p className="mt-8 text-center text-muted-foreground">
        <Trans>Don’t have an account?</Trans>{" "}
        <Link to={`/sign-up${nextQuery}`} className="font-medium text-foreground">
          <Trans>Sign up</Trans>
        </Link>
      </p>
    </AuthFrame>
  );
}
