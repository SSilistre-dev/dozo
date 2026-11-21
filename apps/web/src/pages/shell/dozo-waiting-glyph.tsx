import { useLingui } from "@lingui/react/macro";
import type { DozoQueueItem } from "@rakazo/contracts";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { ActiveBotGlyph } from "../../components/ai/CollaborationMarker";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { errorText, toastError } from "../../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../../lib/query";

/** Rows the list shows before it folds the rest into a count. */
const LIST_ROWS = 4;

type GlyphProps = ComponentProps<typeof ActiveBotGlyph>;

/** One entry per bot: every run of a bot is a working entry, and waiting ones are not more bots. */
const onceEach = (bots: GlyphProps["bots"]) =>
  bots.filter((bot, index) => bots.findIndex((other) => other.botId === bot.botId) === index);

/**
 * The chat's working line. While the caller's own work waits for the bot it says so, what it waits
 * for and, when several wait, its place; tapping it lists what waits and stops the caller's own.
 * Nothing waits for the caller, nothing changes. The queue is read once and read again when the
 * Space signals a runs change (`spaceChanged`), never on a timer.
 */
export function DozoWaitingGlyph({ bots, label, target }: GlyphProps & { target: ArtifactTarget }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const input = target;
  const queue = useQuery(queries.dozoQueue.list.queryOptions({ input }));
  const cancel = useSave({
    save: (item: DozoQueueItem, rpc) =>
      rpc.dozoQueue.cancelWaiting(
        item.kind === "run" ? { runId: item.id } : { messageId: item.id },
      ),
    stale: [queries.dozoQueue.list.key()],
    onFailed: (error) => toastError(errorText(error)),
  });
  const items = queue.data?.items ?? [];
  const first = items.find((item) => item.mine);
  if (!first) return <ActiveBotGlyph bots={bots} label={label} />;

  const line = [
    t`Waiting in line…`,
    first.reason === "behind_run" && first.waitingFor ? t`After ${first.waitingFor}` : null,
    items.length > 1 ? `#${first.position}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const shown = items.slice(0, LIST_ROWS);
  const hidden = items.length - shown.length;
  return (
    <Popover>
      <PopoverTrigger className="block max-w-full cursor-pointer text-start">
        <ActiveBotGlyph bots={onceEach(bots)} label={line} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-1 p-1.5">
        {shown.map((item) => (
          <div key={item.id} data-row className="flex min-h-8 items-center gap-2 px-2 text-body">
            <span className="w-5 shrink-0 text-muted-foreground tabular-nums">{item.position}</span>
            <span dir="auto" className="min-w-0 flex-1 truncate">
              {item.mine && item.label ? item.label : t`Queued`}
            </span>
            {item.mine ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={t`Stop`}
                disabled={cancel.pending}
                onClick={() => cancel.run(item)}
              >
                <X size={14} strokeWidth={1.8} />
              </Button>
            ) : null}
          </div>
        ))}
        {hidden > 0 ? <div className="px-2 text-muted-foreground text-label">+{hidden}</div> : null}
      </PopoverContent>
    </Popover>
  );
}
