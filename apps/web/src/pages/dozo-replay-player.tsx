import { useLingui } from "@lingui/react/macro";
import { DOZO_SHARE_LINK_API_PREFIX, DozoReplayPayloadSchema } from "@rakazo/contracts";
import { Button, LogoAvatar } from "@rakazo/ui-web";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { DozoShareRendererProps } from "./dozo-share-renderers";

/**
 * A replay link, signed out: one step at a time, its screenshot when the owner kept one, and
 * previous and next. The lines are the owner's bot's, so they are drawn as text only.
 */
export function DozoReplayPlayer({ payload, token }: DozoShareRendererProps) {
  const { t } = useLingui();
  const [at, setAt] = useState(0);
  const parsed = DozoReplayPayloadSchema.safeParse(payload);
  const steps = parsed.success ? parsed.data.steps : [];
  const step = steps[Math.min(at, steps.length - 1)];
  return (
    <main
      data-theme="dark"
      className="flex min-h-full flex-col items-center gap-6 bg-background p-6 text-foreground"
    >
      <LogoAvatar className="h-7 w-auto opacity-80" />
      {step ? (
        <div className="flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-4">
          {step.frame !== null ? (
            <img
              key={step.frame}
              src={`${DOZO_SHARE_LINK_API_PREFIX}${token}/frames/${step.frame}`}
              alt=""
              referrerPolicy="no-referrer"
              className="max-h-[70vh] max-w-full rounded-lg border border-border object-contain"
            />
          ) : null}
          <p aria-live="polite" className="max-w-2xl text-center text-body break-words">
            {step.line}
          </p>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Previous`}
              disabled={at === 0}
              onClick={() => setAt(at - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Next`}
              disabled={at >= steps.length - 1}
              onClick={() => setAt(at + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
