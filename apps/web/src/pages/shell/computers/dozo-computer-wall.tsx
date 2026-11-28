import { useLingui } from "@lingui/react/macro";
import type { Bot, ComputerStatus, DozoComputerTile } from "@rakazo/contracts";
import { computerLabel } from "@rakazo/i18n/computer-usage";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useRef, useState } from "react";
import type { ComputerScreenResult } from "../../../lib/computers/computer-screen";
import {
  embeddableScreenUrl,
  isProxiedScreenUrl,
  proxiedScreenCapability,
  SCREEN_FRAME_LOAD_TIMEOUT_MS,
  screenFrameMessage,
  screenFrameStarted,
  screenIframeSandbox,
} from "../../../lib/computers/computer-screen";
import {
  DARWIN_WINDOW_CONTROLS_WIDTH_PX,
  desktopBridge,
  windowChromeKind,
} from "../../../lib/platform/desktop";
import { useSpaceQueries } from "../../../lib/query/query";
import { useEventListener } from "../../../lib/use-event-listener";
import type { DozoSurfaceProps } from "../../dozo-surfaces";
import type { DozoWallShell } from "./dozo-use-computer-controls";
import { useDozoWallShell } from "./dozo-use-computer-controls";

/** At most this many screens stream at once; every other computer shows its bot. */
export const DOZO_WALL_LIVE_MAX = 4;

type State = ComputerStatus["state"];
export type DozoWallTile = { bot: Bot; state: State; live: boolean };

/**
 * One tile per bot of the shell, in the shell's order: computers with a screen first, then other
 * running ones, then starting, then the rest. Only the first `DOZO_WALL_LIVE_MAX` with a screen,
 * and none whose screen dropped while the wall was open, stream.
 */
export function dozoWallTiles(
  bots: readonly Bot[],
  rows: readonly DozoComputerTile[],
  dropped: ReadonlySet<string>,
): DozoWallTile[] {
  const byBot = new Map(rows.map((row) => [row.botId, row]));
  const tiles = bots.map((bot) => {
    const row = byBot.get(bot.id);
    return { bot, state: row?.state ?? "stopped", screen: Boolean(row?.screen) };
  });
  const rank = (tile: (typeof tiles)[number]) =>
    tile.screen ? 0 : tile.state === "running" ? 1 : tile.state === "booting" ? 2 : 3;
  let live = 0;
  return tiles
    .sort((a, b) => rank(a) - rank(b))
    .map(({ bot, state, screen }) => ({
      bot,
      state,
      live: screen && !dropped.has(bot.id) && live++ < DOZO_WALL_LIVE_MAX,
    }));
}

/**
 * The address a tile may frame: never a single-use sign-in (loading it would end the screen
 * someone already watches) nor the control view of a person driving it now.
 */
export function wallScreenUrl(
  screen: Pick<ComputerScreenResult, "url" | "singleUseSignIn"> | undefined,
): string | null {
  if (!screen?.url || screen.singleUseSignIn) return null;
  if (proxiedScreenCapability(screen.url)?.policy === "control") return null;
  return embeddableScreenUrl(screen.url);
}

/** Every bot's computer side by side, live where already running; opening it starts nothing. */
export function DozoComputerWall({ onClose }: DozoSurfaceProps) {
  const { t } = useLingui();
  const shell = useDozoWallShell();
  const queries = useSpaceQueries();
  const client = useQueryClient();
  const list = useQuery(queries.dozoComputerWall.list.queryOptions());
  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set());
  useEventListener(window, "keydown", (event) => {
    if (event.key === "Escape") onClose();
  });
  if (!shell) return null;
  const tiles = list.data ? dozoWallTiles(shell.bots, list.data, dropped) : [];
  const drop = (botId: string) => {
    setDropped((current) => new Set(current).add(botId));
    client.removeQueries({ queryKey: screenKey(botId) });
    void list.refetch();
  };
  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-background" data-testid="computers-wall">
      <div
        className="app-no-drag flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5"
        style={
          windowChromeKind(desktopBridge()) === "darwin"
            ? { paddingLeft: DARWIN_WINDOW_CONTROLS_WIDTH_PX + 18 }
            : undefined
        }
      >
        <h2 className="truncate text-body-lg font-medium text-foreground">{t`Computers`}</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={t`Close`}
          onClick={onClose}
        >
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-[18px]">
        {list.isError ? (
          <div role="alert" className="flex items-center gap-3 text-body text-muted-foreground">
            {t`Could not load`}
            <Button variant="secondary" size="sm" onClick={() => void list.refetch()}>
              {t`Retry`}
            </Button>
          </div>
        ) : list.data && tiles.length === 0 ? (
          <p className="grid h-full place-items-center text-body text-muted-foreground">
            {t`No bots`}
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {tiles.map((tile) => (
              <WallTile
                key={tile.bot.id}
                tile={tile}
                shell={shell}
                onOpen={() => {
                  onClose();
                  shell.openComputer(tile.bot.id);
                }}
                onDropped={() => drop(tile.bot.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const screenKey = (botId: string) => ["dozoComputerWall", "screen", botId];

function WallTile({
  tile,
  shell,
  onOpen,
  onDropped,
}: {
  tile: DozoWallTile;
  shell: DozoWallShell;
  onOpen: () => void;
  onDropped: () => void;
}) {
  const { t } = useLingui();
  const { bot, state, live } = tile;
  // A preview read only watches: it neither starts the computer nor holds off its sleep.
  const screen = useQuery({
    queryKey: screenKey(bot.id),
    queryFn: () => shell.rpc.computer.screenUrl({ botId: bot.id, preview: true }),
    enabled: live,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const url = live ? wallScreenUrl(screen.data) : null;
  const frame = useRef<HTMLIFrameElement>(null);
  const [started, setStarted] = useState<string | null>(null);
  useEventListener(window, "message", (event) => {
    if (!url || !frame.current || event.source !== frame.current.contentWindow) return;
    const message = screenFrameMessage(event.data);
    if (!message) return;
    if (message.rakazoScreen === "failed" || message.rakazoScreen === "disconnected") onDropped();
    else if (screenFrameStarted(message)) setStarted(url);
  });
  // A proxied screen reports its state; one still silent after the load timeout shows its bot.
  useTimeout(
    onDropped,
    isProxiedScreenUrl(url) && started !== url ? SCREEN_FRAME_LOAD_TIMEOUT_MS : null,
    url,
  );
  const label: Record<State, string> = {
    running: t`Running`,
    booting: t`Starting`,
    suspended: t`Asleep`,
    stopped: t`Off`,
    error: t`Error`,
  };
  return (
    <div className="relative" data-testid="computers-wall-tile">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-card">
        {url ? (
          <iframe
            ref={frame}
            title={t`Bot screen preview`}
            tabIndex={-1}
            src={url}
            sandbox={screenIframeSandbox(url)}
            className="pointer-events-none h-full w-full border-0 bg-black"
          />
        ) : (
          <div className="grid h-full place-items-center">
            <BotAvatar
              avatarSet={bot.avatarSet}
              color={bot.color}
              identity={bot.id}
              size={56}
              status={bot.status}
            />
          </div>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 px-1 pt-2.5">
        {url ? (
          <BotAvatar
            avatarSet={bot.avatarSet}
            color={bot.color}
            identity={bot.id}
            size={20}
            status={bot.status}
          />
        ) : null}
        <span className="min-w-0 truncate text-body font-medium text-foreground" dir="auto">
          {bot.name}
        </span>
        {url ? null : (
          <span className="ms-auto shrink-0 text-body-sm text-muted-foreground">
            {label[state]}
          </span>
        )}
      </div>
      {/* Opening the full view of a computer that is not running would start it, so only a
          running one opens; the others are shown, not offered. */}
      {state === "running" ? (
        <button
          type="button"
          aria-label={computerLabel("dedicated", bot.name)}
          className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          onClick={onOpen}
        />
      ) : null}
    </div>
  );
}
