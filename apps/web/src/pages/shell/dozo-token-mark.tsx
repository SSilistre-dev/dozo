import { useLingui } from "@lingui/react/macro";
import { KeyRound } from "lucide-react";

/**
 * Above a message that came in with a personal access token (the bot API, MCP) instead of being
 * typed in the app: a small key, named for screen readers and on hover. Its run asks before acting.
 */
export function DozoTokenMark() {
  const { t } = useLingui();
  const label = t`Sent with an access token`;
  return (
    <div className="mb-1 flex justify-end text-muted-foreground" title={label}>
      <KeyRound role="img" aria-label={label} className="size-3.5" />
    </div>
  );
}
