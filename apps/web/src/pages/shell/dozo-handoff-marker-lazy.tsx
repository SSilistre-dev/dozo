import type { ComponentProps } from "react";
import { lazy, Suspense } from "react";
import type { DozoHandoffMarkerView } from "./dozo-handoff-marker";

const View = lazy(() =>
  import("./dozo-handoff-marker").then((module) => ({ default: module.DozoHandoffMarkerView })),
);

/** Loaded when a chat first shows a one-to-one handoff, so first paint does not carry it. */
export function DozoHandoffMarker(props: ComponentProps<typeof DozoHandoffMarkerView>) {
  return (
    <Suspense fallback={null}>
      <View {...props} />
    </Suspense>
  );
}
