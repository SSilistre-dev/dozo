import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { LinkResult, OnwardLink } from "./dozo-email-link";

/**
 * The end of a flow that left the app: the sign-in column's logo, heading and one onward button.
 * Callback, failure and "not available" pages share it so a visitor always sees the same frame
 * and exactly one next step.
 */
export function ResultPage({
  title,
  detail,
  to,
  children,
}: {
  title: ReactNode;
  detail?: string | null;
  to: string;
  children: ReactNode;
}) {
  return (
    <LinkResult title={title} detail={detail}>
      <OnwardLink to={to} primary>
        {children}
      </OnwardLink>
    </LinkResult>
  );
}

/** Where a popup or tab rests after an outside flow (sign-in, OAuth) hands control back. */
export function CallbackResult() {
  return (
    <ResultPage title={<Trans>You can close this window.</Trans>} to="/">
      <Trans>Return to Dozo</Trans>
    </ResultPage>
  );
}

/** A link that leads nowhere: shared page turned off or deleted. */
export function PageUnavailable() {
  const { t } = useLingui();
  return (
    <ResultPage
      title={<Trans>This page isn't available</Trans>}
      detail={t`The owner may have turned off its link or deleted it.`}
      to="/"
    >
      <Trans>Open Dozo</Trans>
    </ResultPage>
  );
}

/** Slack's install page when the connection did not complete: back to the messaging settings. */
export function SlackInstallFailed() {
  return (
    <ResultPage title={<Trans>Could not connect</Trans>} to="/app?settings=messaging">
      <Trans>Return to Dozo</Trans>
    </ResultPage>
  );
}

/** The MCP OAuth page: its state as the heading, the provider's reason under it, one way on. */
export function McpOAuthResult({ error, done }: { error: string | null; done: boolean }) {
  return (
    <ResultPage
      title={
        error ? (
          <Trans>OAuth connection failed</Trans>
        ) : done ? (
          <Trans>Connected</Trans>
        ) : (
          <Trans>Finishing MCP connection…</Trans>
        )
      }
      detail={error}
      to="/app"
    >
      <Trans>Return to Dozo</Trans>
    </ResultPage>
  );
}
