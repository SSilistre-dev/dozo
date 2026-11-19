// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  locale: "en",
  data: undefined as { en: string | null; tr: string | null } | undefined,
  reads: [] as unknown[][],
}));

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ i18n: { locale: state.locale } }) }));
vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div role="status">{children}</div>,
}));
vi.mock("./native", () => ({
  useMobileTokens: () => ({ mutedForeground: "muted", border: "border" }),
}));
vi.mock("./query", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient(),
    rpcQuery: (proc: string) => ({ queryKey: ["server", "space", proc, {}] }),
  };
});
vi.mock("./screen-query", () => ({
  useScreenQuery: (read: { queryKey: unknown[] }) => {
    state.reads.push(read.queryKey);
    return { data: state.data };
  },
}));

import { DozoAnnouncementLine } from "../components/dozo-announcement-line";
import { dozoSiteChanged } from "./dozo-site-settings";
import { queryClient as client } from "./query";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const line = () => container.querySelector('[role="status"]');
const render = () => act(() => root.render(<DozoAnnouncementLine />));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.locale = "en";
  state.data = undefined;
  state.reads = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DozoAnnouncementLine", () => {
  it("shows the announcement in the app's language", () => {
    state.data = { en: "Maintenance tonight", tr: "Bu gece bakım var" };
    render();
    expect(line()?.textContent).toBe("Maintenance tonight");
    expect(state.reads[0]).toEqual(["server", "space", "dozoSiteSettings/announcement", {}]);
    state.locale = "tr";
    render();
    expect(line()?.textContent).toBe("Bu gece bakım var");
  });

  it("shows nothing while it loads or when there is none", () => {
    render();
    expect(line()).toBeNull();
    state.data = { en: null, tr: null };
    render();
    expect(line()).toBeNull();
  });
});

describe("dozoSiteChanged", () => {
  it("reads the announcement again and leaves every other read alone", async () => {
    const announcement = ["server", "space", "dozoSiteSettings/announcement", {}];
    const other = ["server", "space", "billing/status", {}];
    client.setQueryData(announcement, { en: "Old", tr: null });
    client.setQueryData(other, { state: "active" });
    await dozoSiteChanged();
    expect(client.getQueryState(announcement)?.isInvalidated).toBe(true);
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
  });
});
