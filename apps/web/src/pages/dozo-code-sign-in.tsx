import { Trans, useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import type { SignInProvider } from "@rakazo/contracts";
import { credentialIssue } from "@rakazo/core";
import { authErrorText, credentialIssueText } from "@rakazo/i18n/user-error";
import { Button, Input, InputOTP, InputOTPGroup, InputOTPSlot, Label } from "@rakazo/ui-web";
import { useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { usePasskeySignIn } from "../components/account/PasskeySignIn";
import { SocialSignInButtons } from "../components/account/SocialSignInButtons";
import { authClient } from "../lib/auth/auth";
import { newAccountDestination, signInNext } from "../lib/auth/sign-in-next";
import { runSsoFlow } from "../lib/auth/sso-flow";
import { useSave } from "../lib/query/query";
import { clearSpaceSelection } from "../lib/query/rpc";
import { AuthFrame, submitClass } from "./auth/Auth";
import { DozoSignupTerms } from "./dozo-signup-terms";

const CODE_LENGTH = 6;

/** The first code point of each run of ten decimal digits a keyboard or a mail may give. */
const DIGIT_ZEROS = [
  0x30, // ASCII
  0x660, // Arabic-Indic
  0x6f0, // Extended Arabic-Indic (Persian, Urdu)
  0x966, // Devanagari
  0x9e6, // Bengali
  0xe50, // Thai
  0xff10, // Fullwidth
];

/**
 * The digits of a typed or pasted code as ASCII: other scripts' and fullwidth digits are turned
 * into 0-9, anything else (spaces, dashes, letters) is dropped. The server takes ASCII only.
 */
export function dozoCodeDigits(text: string): string {
  let digits = "";
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    const zero = DIGIT_ZEROS.find((start) => point >= start && point < start + 10);
    if (zero !== undefined) digits += String(point - zero);
  }
  return digits;
}
/** How long "Resend code" waits after a code was sent; the server keeps its own limit. */
export const RESEND_AFTER_MS = 30_000;

/** The server answered and refused, and its reason is the message; any other failure is ours. */
class Refused extends Error {}

/**
 * Email-first sign-in (dozo/design/signin-v2.html): an address, then the six-digit code the
 * server mails. It calls the same client functions as upstream's blank-password path
 * (`emailOtp.sendVerificationOtp`, `signIn.emailOtp`), so what the server decides is unchanged:
 * a known and an unknown address see the same steps, and an unknown one gets an account only
 * under the deployment's sign-up policy. A password is the way round: "Use a password instead"
 * opens upstream's own form at `/sign-in/email`, handing it the address in the history entry.
 * The deployment's providers and passkeys stay on the first step.
 *
 * Sign-up (`mode="up"`) is the same two steps with a name beside the address and no password at
 * all: a password account made by a mailed link can only finish in the browser that opened the
 * link. The code makes the account, and the name goes with it (`signIn.emailOtp` uses it only when
 * it creates one), so `sign-up/email` is never called.
 */
export function DozoCodeSignIn({
  providers,
  mode = "in",
}: {
  providers: SignInProvider[];
  mode?: "in" | "up";
}) {
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
  const signingUp = mode === "up";
  const [name, setName] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [code, setCode] = useState("");
  const [sentAt, setSentAt] = useState(0);
  const [misses, setMisses] = useState(0);
  // Signed in: the routes move the user on once the session refetch lands, so nothing is offered
  // again meanwhile.
  const [entered, setEntered] = useState(false);
  const [returned, setReturned] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const failed = searchParams.get("error");
    return failed ? authErrorText({ code: failed }, t`Could not continue`) : null;
  });
  const emailIssue = error === credentialIssueText("email");
  const passkey = usePasskeySignIn({
    onSignedIn: () => {
      clearSpaceSelection();
      setEntered(true);
    },
    onError: setError,
    autoFill: true,
  });
  const waiting = sentAt > 0 && step === "code";
  const now = useNow(waiting ? 1000 : null);
  const left = waiting ? Math.max(0, Math.ceil((sentAt + RESEND_AFTER_MS - now) / 1000)) : 0;

  // What a call to the server answers, as the person is told it.
  async function answered<T extends { error?: unknown }>(call: Promise<T>): Promise<void> {
    let result: T;
    try {
      result = await call;
    } catch {
      throw new Error(t`Could not reach the server`);
    }
    if (result.error) throw new Refused(authErrorText(result.error, t`Could not continue`));
  }

  const sendCode = useSave<"email" | "resend">({
    save: () =>
      answered(authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "sign-in" })),
    onSaved: (_saved, from) => {
      setSentAt(Date.now());
      if (from === "email") {
        setCode("");
        setMisses(0);
        setStep("code");
      }
    },
    onFailed: (failure) => setError(failure.message),
  });

  // A code is checked once: a second submit while the first is on its way would spend another of
  // the code's three attempts, and `run` ignores it.
  const checkCode = useSave<string>({
    save: (otp) =>
      answered(
        authClient.signIn.emailOtp({
          email: email.trim(),
          otp,
          ...(signingUp ? { name: name.trim() || email.trim().split("@")[0] || "User" } : {}),
        }),
      ),
    onSaved: () => {
      clearSpaceSelection();
      // Forgetting the Space changes what `useSave` holds a save under, so it would let go of this
      // one: the sign-in is held here, as the passkey's is.
      setEntered(true);
    },
    onFailed: (failure) => {
      setError(failure.message);
      if (failure instanceof Refused) {
        setCode("");
        setMisses((count) => count + 1);
      }
    },
    closesScreen: true,
  });
  const pending = sendCode.pending || checkCode.pending || entered;

  function send(from: "email" | "resend") {
    if (entered) return;
    setError(null);
    sendCode.run(from);
  }

  function verify(otp: string) {
    // Signed in: the code was spent, and the controls are held until the routes move the user on.
    if (entered) return;
    setError(null);
    checkCode.run(otp);
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
          if (code.length === CODE_LENGTH) verify(code);
        }}
      >
        <p data-dozo-auth-address className="w-full text-center text-muted-foreground">
          {email.trim()}
        </p>
        <div key={misses} data-dozo-code data-missed={misses > 0 || undefined}>
          <InputOTP
            aria-label={t({ message: "Code", context: "email sign-in" })}
            maxLength={CODE_LENGTH}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            disabled={pending}
            value={code}
            onChange={(value: string) => {
              const digits = dozoCodeDigits(value).slice(0, CODE_LENGTH);
              // Something was typed or pasted and none of it is a digit: say so, never nothing.
              if (value.length > code.length && digits.length <= code.length) {
                setError(t`Invalid code`);
                return;
              }
              setCode(digits);
              if (digits) setError(null);
              if (digits.length === CODE_LENGTH) verify(digits);
            }}
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
            disabled={(sendCode.pending || checkCode.pending) && !entered}
            onClick={() => {
              setStep("email");
              setReturned(true);
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
              send("resend");
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
      title={signingUp ? <Trans>Create your account</Trans> : <Trans>Sign in to Rakazo</Trans>}
      onSubmit={(event) => {
        event.preventDefault();
        const issue = credentialIssue({ email });
        if (issue) {
          setError(credentialIssueText(issue));
          return;
        }
        send("email");
      }}
    >
      {signingUp ? (
        <div className="mb-4 w-full">
          <Label htmlFor="name" className="text-muted-foreground">
            <Trans>Name</Trans>
          </Label>
          <Input
            id="name"
            name="name"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t`Your name`}
          />
        </div>
      ) : null}
      <div className="w-full">
        <Label htmlFor="email" className="text-muted-foreground">
          <Trans>Email</Trans>
        </Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete={signingUp ? "email" : "username webauthn"}
          // Back from the code step lands on the address, ready to correct it.
          autoFocus={returned}
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
      {signingUp ? <DozoSignupTerms /> : null}
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
        {passkey.supported && !signingUp ? (
          <button
            type="button"
            data-dozo-quiet
            disabled={pending || passkey.pending}
            onClick={passkey.start}
          >
            <Trans>Continue with passkey</Trans>
          </button>
        ) : null}
        {signingUp ? null : (
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
        )}
      </div>
      <p className="mt-8 text-center text-muted-foreground">
        {signingUp ? (
          <>
            <Trans>Already have an account?</Trans>{" "}
            <Link to={`/sign-in${nextQuery}`} className="font-medium text-foreground">
              <Trans>Sign in</Trans>
            </Link>
          </>
        ) : (
          <>
            <Trans>Don’t have an account?</Trans>{" "}
            <Link to={`/sign-up${nextQuery}`} className="font-medium text-foreground">
              <Trans>Sign up</Trans>
            </Link>
          </>
        )}
      </p>
    </AuthFrame>
  );
}
