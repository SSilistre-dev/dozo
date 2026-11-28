import type { Bot } from "@rakazo/contracts";
import { useEffect, useSyncExternalStore } from "react";
import type { createSpaceRpc } from "../../../lib/query/rpc";
import { useComputerControls as upstreamUseComputerControls } from "./use-computer-controls";

/** What the computers wall needs from the open shell: its bots, its client, and the full view. */
export type DozoWallShell = {
  bots: readonly Bot[];
  rpc: ReturnType<typeof createSpaceRpc>;
  openComputer: (botId: string) => void;
};

let shell: DozoWallShell | null = null;
const listeners = new Set<() => void>();

function publish(next: DozoWallShell | null) {
  shell = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The shell the wall opens over, or null while none is mounted. */
export function useDozoWallShell(): DozoWallShell | null {
  return useSyncExternalStore(subscribe, () => shell);
}

/**
 * Upstream's computer controls, which also hand the computers wall (a surface outside the shell)
 * the shell's bots and the way to open one bot's full computer view.
 */
export function useComputerControls(options: Parameters<typeof upstreamUseComputerControls>[0]) {
  const controls = upstreamUseComputerControls(options);
  const { bots, rpc } = options;
  const { onOpenComputer } = controls;
  useEffect(() => {
    const own: DozoWallShell = { bots, rpc, openComputer: (botId) => onOpenComputer(botId) };
    publish(own);
    return () => {
      if (shell === own) publish(null);
    };
  }, [bots, rpc, onOpenComputer]);
  return controls;
}
