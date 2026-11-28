import type { ComponentType } from "react";
import { Suspense } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { lazyComponent } from "./platform/preload-recovery";

export type DozoLazyLoader<Props> = () => Promise<ComponentType<Props>>;

/** Each entry's component, loaded when first drawn; made once, where the list is declared. */
export function dozoLazyEntries<Props>(
  loaders: readonly DozoLazyLoader<Props>[],
): ComponentType<Props>[] {
  return loaders.map((load) => lazyComponent(load) as unknown as ComponentType<Props>);
}

/**
 * Every entry drawn with the same props, in order. Nothing stands in an entry's place while it
 * loads, and an entry whose code fails stays out.
 */
export function DozoLazyList<Props extends object>({
  entries,
  props,
}: {
  entries: readonly ComponentType<Props>[];
  props: Props;
}) {
  // The list never changes while the app runs, so an entry's place is its key.
  return entries.map((Entry, index) => (
    <ErrorBoundary key={index} fallback={null}>
      <Suspense fallback={null}>
        <Entry {...props} />
      </Suspense>
    </ErrorBoundary>
  ));
}
