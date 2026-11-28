import type { ComponentType } from "react";
import { Suspense, useEffect, useState } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { lazyComponent } from "../lib/platform/preload-recovery";

export type DozoSurfaceProps = { params: Readonly<Record<string, string>>; onClose: () => void };
type Surfaces = Readonly<Record<string, () => Promise<ComponentType<DozoSurfaceProps>>>>;

/**
 * The fork's signed-in surfaces that cover the shell (an overlay or a full page), each loaded when
 * first opened. A feature adds one line, `<key>: () => import("./x").then((module) => module.X)`,
 * and opens it with `openDozoSurface(<key>, params)` from a menu item or row.
 */
const SURFACES: Surfaces = {
  computers: () =>
    import("./shell/computers/dozo-computer-wall").then((module) => module.DozoComputerWall),
  replay: () => import("./shell/dozo-replay-surface").then((module) => module.DozoReplaySurface),
};

type Opened = { key: string; params: Readonly<Record<string, string>> };
let request: ((opened: Opened | null) => void) | null = null;
const loaded = new WeakMap<Surfaces, Map<string, ComponentType<DozoSurfaceProps>>>();

/** Opens a surface over the shell; an unknown key, or no shell on screen, does nothing. */
export function openDozoSurface(key: string, params: Readonly<Record<string, string>> = {}) {
  request?.({ key, params });
}

function surfaceFor(surfaces: Surfaces, key: string) {
  if (!Object.hasOwn(surfaces, key)) return null;
  const byKey = loaded.get(surfaces) ?? new Map<string, ComponentType<DozoSurfaceProps>>();
  loaded.set(surfaces, byKey);
  const Surface =
    byKey.get(key) ?? (lazyComponent(surfaces[key]!) as unknown as ComponentType<DozoSurfaceProps>);
  byKey.set(key, Surface);
  return Surface;
}

/** Mounted once beside the shell (dozo-shell.tsx); holds which surface is open, if any. */
export function DozoSurfaceHost({ surfaces = SURFACES }: { surfaces?: Surfaces }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  useEffect(() => {
    request = setOpened;
    return () => {
      if (request === setOpened) request = null;
    };
  }, []);
  const Surface = opened ? surfaceFor(surfaces, opened.key) : null;
  if (!opened || !Surface) return null;
  return (
    <ErrorBoundary key={opened.key} fallback={null}>
      <Suspense fallback={null}>
        <Surface params={opened.params} onClose={() => setOpened(null)} />
      </Suspense>
    </ErrorBoundary>
  );
}
