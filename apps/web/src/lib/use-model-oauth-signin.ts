import type { ModelOAuthBegin, SettingsScope, ThinkingLevel } from "@rakazo/contracts";
import { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import { desktopBridge, oauthStateOf, onDesktopOAuthCallback } from "./desktop";
import { waitForModelOAuth } from "./model-auth";
import { useSpaceRpc } from "./space-rpc";
import { errorText } from "./user-error";

type OAuthPhase = "idle" | "waiting" | "connecting";

/** A submit that ended without ending the attempt goes back to waiting for a code. */
const leaveConnecting = (phase: OAuthPhase): OAuthPhase =>
  phase === "connecting" ? "waiting" : phase;

/** How often to check a pasted code's exchange: it normally finishes within a second or two. */
const CODE_EXCHANGE_POLL_MS = 1000;

export type ModelOAuthSignInBegin = {
  provider: string;
  /** The connection to sign in again; null adds another. */
  credentialId?: string | null;
  modelId?: string;
  thinkingLevel?: ThinkingLevel | null;
  makeDefault?: boolean;
  /** Where makeDefault sets the main model. */
  scope?: SettingsScope;
  label?: string;
};

/**
 * Shared subscription sign-in lifecycle for desktop loopback capture and the
 * paste fallback. Preserves attempt-owned capture unsubscribe and submitting
 * guards so cancel-and-retry cannot drop a newer callback.
 */
export function useModelOAuthSignIn(options: {
  /** `credentialId` is the connection the sign-in saved. */
  onFinished: (controller: AbortController, credentialId: string) => void | Promise<void>;
  onError: (message: string) => void;
  onClearError?: () => void;
}) {
  const rpc = useSpaceRpc();
  const { onFinished, onError, onClearError } = options;
  const [oauth, setOauth] = useState<ModelOAuthBegin | null>(null);
  const [pasteCode, setPasteCode] = useState("");
  const [oauthPhase, setOauthPhase] = useState<OAuthPhase>("idle");
  const oauthPending = oauthPhase !== "idle";
  const oauthSubmitting = oauthPhase === "connecting";
  const [popupBlocked, setPopupBlocked] = useState(false);
  const oauthAbortRef = useRef<AbortController | null>(null);
  const oauthLoginIdRef = useRef<string | null>(null);
  const oauthCodeSubmittingRef = useRef(false);
  const oauthCaptureRef = useRef<(() => void) | null>(null);
  const onFinishedRef = useRef(onFinished);
  const onErrorRef = useRef(onError);
  const onClearErrorRef = useRef(onClearError);
  onFinishedRef.current = onFinished;
  onErrorRef.current = onError;
  onClearErrorRef.current = onClearError;

  function releaseOAuthCapture(expected?: (() => void) | null) {
    if (expected !== undefined && oauthCaptureRef.current !== expected) return;
    oauthCaptureRef.current?.();
    oauthCaptureRef.current = null;
  }

  function cancelOAuthAttempt(resetState = true) {
    releaseOAuthCapture();
    oauthCodeSubmittingRef.current = false;
    setOauthPhase(leaveConnecting);
    const loginId = oauthLoginIdRef.current;
    oauthLoginIdRef.current = null;
    cancelModelOAuthAttempt(oauthAbortRef, () => {
      if (resetState) {
        setOauth(null);
        setOauthPhase("idle");
        setPopupBlocked(false);
      }
    });
    if (loginId) void rpc.models.cancelOAuth({ loginId }).catch(() => undefined);
  }

  async function finishSubscriptionSignIn(
    loginId: string,
    controller: AbortController,
    pollIntervalMs?: number,
  ) {
    await waitForModelOAuth(loginId, controller.signal, rpc, pollIntervalMs);
    if (controller.signal.aborted) return;
    const saved = await rpc.models.finishOAuth({ loginId }, { signal: controller.signal });
    if (controller.signal.aborted) return;
    oauthLoginIdRef.current = null;
    setOauth(null);
    // Keep post-connect UI work outside the OAuth try/catch so a refresh failure
    // is not reported as a failed sign-in (finishOAuth already persisted).
    try {
      await onFinishedRef.current(controller, saved.id);
    } catch (err) {
      if (controller.signal.aborted) return;
      onErrorRef.current(errorText(err, "Connected, but could not refresh"));
    }
  }

  async function submitOAuthCode(captured?: string, login?: ModelOAuthBegin) {
    const attempt = login ?? oauth;
    if (attempt?.mode !== "auth-url" || oauthCodeSubmittingRef.current) return;
    const controller = oauthAbortRef.current;
    const capture = oauthCaptureRef.current;
    const code = (captured ?? pasteCode).trim();
    if (!controller || !code) return;
    oauthCodeSubmittingRef.current = true;
    setOauthPhase("connecting");
    setPasteCode("");
    onClearErrorRef.current?.();
    let submitted = false;
    let retryable = false;
    try {
      await rpc.models.submitOAuthCode(
        { loginId: attempt.loginId, code },
        { signal: controller.signal },
      );
      submitted = true;
      // The server exchanges the code in the background; check often until it is done.
      await finishSubscriptionSignIn(attempt.loginId, controller, CODE_EXCHANGE_POLL_MS);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (submitted) {
        oauthLoginIdRef.current = null;
        setOauth(null);
        void rpc.models.cancelOAuth({ loginId: attempt.loginId }).catch(() => undefined);
      } else {
        retryable = true;
        setPasteCode(code);
      }
      onErrorRef.current(errorText(err, "Could not finish sign-in"));
    } finally {
      // A cancelled attempt may already have started another sign-in; do not clear
      // its submitting guard or the newer desktop callback is dropped.
      if (oauthAbortRef.current === controller) {
        oauthCodeSubmittingRef.current = false;
        setOauthPhase(leaveConnecting);
      }
      if (!retryable) {
        // Only drop this attempt's listener — a newer sign-in may already own the ref.
        releaseOAuthCapture(capture);
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPhase("idle"));
      }
    }
  }

  async function startSubscriptionSignIn(begin: ModelOAuthSignInBegin) {
    onClearErrorRef.current?.();
    setOauthPhase("waiting");
    setPopupBlocked(false);
    const controller = new AbortController();
    oauthAbortRef.current = controller;
    let waitingForCode = false;
    try {
      const started = await rpc.models.beginOAuth(
        {
          provider: begin.provider,
          ...(begin.credentialId !== undefined ? { credentialId: begin.credentialId } : {}),
          modelId: begin.modelId,
          thinkingLevel: begin.thinkingLevel,
          makeDefault: begin.makeDefault,
          ...(begin.scope ? { scope: begin.scope } : {}),
          label: begin.label,
          // Desktop receives the loopback redirect; a browser tab cannot, so it gets a code page.
          codePage: !desktopBridge(),
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      oauthLoginIdRef.current = started.loginId;
      setPasteCode("");
      setOauth(started);
      if (started.mode === "auth-url") {
        // Subscribe before the popup exists: a provider that is already
        // authorized can redirect before React commits the state above.
        releaseOAuthCapture();
        oauthCaptureRef.current = onDesktopOAuthCallback(
          (code) => void submitOAuthCode(code, started),
          oauthStateOf(started.verificationUri),
        );
      }
      const browserAuth = desktopBridge()?.oauth;
      if (browserAuth?.open) {
        const cancelBrowser = () =>
          void browserAuth.cancel?.(started.verificationUri).catch(() => undefined);
        controller.signal.addEventListener("abort", cancelBrowser, { once: true });
        const releaseCapture = oauthCaptureRef.current;
        oauthCaptureRef.current = () => {
          releaseCapture?.();
          controller.signal.removeEventListener("abort", cancelBrowser);
          cancelBrowser();
        };
        await browserAuth.open(started.verificationUri);
        if (controller.signal.aborted) return;
      } else {
        // noopener returns null even when the tab opens. Detach a blank tab
        // before navigating so the handle can distinguish a blocked popup.
        const popup = window.open("about:blank", "_blank");
        if (popup) {
          popup.opener = null;
          // A noreferrer link suppresses the navigation request's Referer header.
          const link = popup.document.createElement("a");
          link.href = started.verificationUri;
          link.rel = "noreferrer";
          popup.document.body.append(link);
          link.click();
        } else {
          setPopupBlocked(true);
        }
      }
      waitingForCode = started.mode === "auth-url";
      if (!waitingForCode) await finishSubscriptionSignIn(started.loginId, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      const loginId = oauthLoginIdRef.current;
      oauthLoginIdRef.current = null;
      if (loginId) void rpc.models.cancelOAuth({ loginId }).catch(() => undefined);
      onErrorRef.current(errorText(err, "Could not start sign-in"));
      setOauth(null);
    } finally {
      if (!waitingForCode) {
        if (oauthAbortRef.current === controller) releaseOAuthCapture();
        finishModelOAuthAttempt(oauthAbortRef, controller, () => setOauthPhase("idle"));
      }
    }
  }

  useEffect(() => () => cancelOAuthAttempt(false), []);

  return {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    oauthSubmitting,
    popupBlocked,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  };
}
