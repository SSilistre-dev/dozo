import type { DozoShared } from "@rakazo/contracts";
import { DOZO_SHARE_LINK_API_PREFIX, looksLikeDozoShareToken } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Suspense } from "react";
import { ErrorBoundary, SectionLoadFailed } from "../components/ErrorBoundary";
import { PageLoading } from "../components/PageLoading";
import { lazyComponent } from "../lib/platform/preload-recovery";
import type { DozoShareRenderer } from "./dozo-share-renderers";
import { DOZO_SHARE_RENDERERS } from "./dozo-share-renderers";

type Renderers = Readonly<Record<string, () => Promise<DozoShareRenderer>>>;

async function readShared(token: string): Promise<DozoShared | null> {
  const response = await fetch(`${DOZO_SHARE_LINK_API_PREFIX}${token}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Share link returned ${response.status}`);
  return (await response.json()) as DozoShared;
}

const loaded = new WeakMap<Renderers, Map<string, DozoShareRenderer>>();

function rendererFor(renderers: Renderers, kind: string) {
  if (!Object.hasOwn(renderers, kind)) return null;
  const byKind = loaded.get(renderers) ?? new Map<string, DozoShareRenderer>();
  loaded.set(renderers, byKind);
  const Renderer =
    byKind.get(kind) ?? (lazyComponent(renderers[kind]!) as unknown as DozoShareRenderer);
  byKind.set(kind, Renderer);
  return Renderer;
}

/**
 * What a share link shows, for anyone holding it, signed in or not. Every link the server refuses,
 * and every kind this build cannot draw, shows `notFound`.
 */
export function DozoSharePage({
  token,
  notFound,
  renderers = DOZO_SHARE_RENDERERS,
}: {
  token: string;
  notFound: ReactNode;
  renderers?: Renderers;
}) {
  const valid = looksLikeDozoShareToken(token);
  const shared = useQuery({
    queryKey: ["dozo-shared", token],
    queryFn: () => readShared(token),
    enabled: valid,
    retry: false,
  });
  const Renderer = shared.data ? rendererFor(renderers, shared.data.kind) : null;
  const body =
    !valid || shared.data === null || (shared.data && !Renderer) ? (
      notFound
    ) : shared.isError ? (
      <SectionLoadFailed />
    ) : !shared.data || !Renderer ? (
      <PageLoading />
    ) : (
      <ErrorBoundary fallback={<SectionLoadFailed />}>
        <Suspense fallback={<PageLoading />}>
          <Renderer payload={shared.data.payload} />
        </Suspense>
      </ErrorBoundary>
    );
  return (
    <>
      {/* The link is its only key: no search result, and no request from the page names it. */}
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      {body}
    </>
  );
}
