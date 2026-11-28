import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoReplayDraftStep, DozoShareLink } from "@rakazo/contracts";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  useCopyText,
} from "@rakazo/ui-web";
import type { QueryKey } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useId, useState } from "react";
import { PageLoading } from "../../components/PageLoading";
import { errorText, toastError } from "../../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import type { DozoSurfaceProps } from "../dozo-surfaces";

/** What the owner keeps: steps left out, and the steps whose screenshot goes with them. */
type Choice = { omit: Set<number>; frames: Set<number> };

/** Every step starts kept; a screenshot starts kept unless the server says it starts left out. */
export function startingChoice(steps: readonly DozoReplayDraftStep[]): Choice {
  return {
    omit: new Set(),
    frames: new Set(steps.flatMap((step, index) => (step.frame && !step.sensitive ? [index] : []))),
  };
}

function toggled(set: Set<number>, index: number, on: boolean): Set<number> {
  const next = new Set(set);
  if (on) next.add(index);
  else next.delete(index);
  return next;
}

/**
 * The owner's review of one reply before it becomes a public replay: every step and screenshot
 * that would show, each one theirs to leave out, then the link. Their live links to the reply are
 * listed here too, where they revoke them.
 */
export function DozoReplaySurface({ params, onClose }: DozoSurfaceProps) {
  const messageId = params.messageId ?? "";
  const queries = useSpaceQueries();
  const input = { messageId };
  const preview = useQuery({
    ...queries.dozoReplays.preview.queryOptions({ input }),
    enabled: Boolean(messageId),
    staleTime: 0,
  });
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent data-testid="dozo-replay" className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            <Trans>Share replay</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Anyone with the link can see what stays checked.</Trans>
          </DialogDescription>
        </DialogHeader>
        {preview.isError ? (
          <p role="alert" className="text-body-sm text-destructive">
            {errorText(preview.error)}
          </p>
        ) : !preview.data ? (
          <PageLoading />
        ) : (
          <Review
            messageId={messageId}
            steps={preview.data.steps}
            links={preview.data.links}
            stale={queries.dozoReplays.preview.key({ input })}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Review({
  messageId,
  steps,
  links,
  stale,
}: {
  messageId: string;
  steps: DozoReplayDraftStep[];
  links: DozoShareLink[];
  stale: QueryKey;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [choice, setChoice] = useState(() => startingChoice(steps));
  const [url, setUrl] = useState<string | null>(null);
  const [copied, copy] = useCopyText();
  const publish = useSave({
    save: (_input: undefined, rpc) =>
      rpc.dozoReplays.publish({
        messageId,
        omit: [...choice.omit],
        frames: [...choice.frames].filter((index) => !choice.omit.has(index)),
      }),
    stale: [stale],
    onSaved: (made) => {
      setUrl(made.url);
      void copy(made.url);
    },
  });
  const kept = steps.length - choice.omit.size;
  return (
    <>
      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => {
          const on = !choice.omit.has(index);
          return (
            // The list never changes while the review is open, so a step's place is its key.
            <li key={index} className="flex flex-col gap-2">
              <div className="flex items-center gap-2.5 text-body">
                <Checkbox
                  id={`${ids}-step-${index}`}
                  checked={on}
                  onCheckedChange={(checked) =>
                    setChoice({ ...choice, omit: toggled(choice.omit, index, !checked) })
                  }
                />
                <label htmlFor={`${ids}-step-${index}`} className="min-w-0 break-words">
                  {step.line}
                </label>
              </div>
              {step.frame && on ? (
                <div className="ms-6.5 flex flex-col gap-1.5 text-body-sm text-muted-foreground">
                  <div className="flex items-center gap-2.5">
                    <Checkbox
                      id={`${ids}-frame-${index}`}
                      checked={choice.frames.has(index)}
                      onCheckedChange={(checked) =>
                        setChoice({ ...choice, frames: toggled(choice.frames, index, checked) })
                      }
                    />
                    <label htmlFor={`${ids}-frame-${index}`}>
                      <Trans>Screenshot</Trans>
                    </label>
                  </div>
                  <ReviewFrame
                    messageId={messageId}
                    index={index}
                    chosen={choice.frames.has(index)}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {publish.error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {errorText(publish.error)}
        </p>
      ) : null}
      {url ? (
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={url}
            aria-label={t`Link`}
            onFocus={(event) => event.target.select()}
          />
          <Button variant="outline" aria-label={t`Copy`} onClick={() => void copy(url)}>
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
      ) : null}
      <LiveLinks links={links} stale={stale} />
      <DialogFooter>
        <Button disabled={kept === 0 || publish.pending} onClick={() => publish.run(undefined)}>
          <Trans>Create link</Trans>
        </Button>
      </DialogFooter>
    </>
  );
}

/** One step's screenshot, read on its own when the review shows it; nothing when it is gone. */
function ReviewFrame({
  messageId,
  index,
  chosen,
}: {
  messageId: string;
  index: number;
  chosen: boolean;
}) {
  const queries = useSpaceQueries();
  const frame = useQuery(queries.dozoReplays.frame.queryOptions({ input: { messageId, index } }));
  if (!frame.data?.frame) return null;
  return (
    <img
      src={frame.data.frame}
      alt=""
      className={`max-h-48 w-fit rounded-md border border-border object-contain ${
        chosen ? "" : "opacity-40"
      }`}
    />
  );
}

function LiveLinks({ links, stale }: { links: DozoShareLink[]; stale: QueryKey }) {
  const { i18n } = useLingui();
  const revoke = useSave({
    save: (id: string, rpc) => rpc.dozoShareLinks.revoke({ id }),
    stale: [stale],
    onFailed: (error) => toastError(errorText(error)),
  });
  if (links.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 border-t border-border pt-3">
      {links.map((link) => {
        const date = i18n.date(new Date(link.expiresAt), { dateStyle: "medium" });
        return (
          <li key={link.id} className="flex items-center gap-2 text-body-sm text-muted-foreground">
            <span className="me-auto">
              <Trans>Expires {date}</Trans>
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={revoke.pending}
              onClick={() => revoke.run(link.id)}
            >
              <Trans>Revoke</Trans>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
