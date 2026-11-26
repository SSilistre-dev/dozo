// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  read: vi.fn(),
  signal: undefined as (() => unknown) | undefined,
  enabled: [] as boolean[],
  focus: undefined as (() => void) | undefined,
}));

vi.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void) => {
    state.focus = effect;
  },
}));
vi.mock("./platform/app-foreground", () => ({ useAppForeground: () => true }));

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  Image: ({
    source,
    accessibilityLabel,
  }: {
    source: { uri?: string };
    accessibilityLabel?: string;
  }) => <img src={source.uri} alt={accessibilityLabel} />,
}));
vi.mock("./native/native", () => ({
  native: { separator: "separator" },
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));
vi.mock("./query/query", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    rpcQuery: (proc: string) => ({
      queryKey: ["server", "space", proc, {}],
      queryFn: () => state.read(proc),
    }),
  };
});
vi.mock("./api/roster-signals", () => ({
  useRosterSignals: (read: () => unknown, enabled: boolean) => {
    state.signal = read;
    state.enabled.push(enabled);
  },
}));

import { dozoHomeTitle, useDozoOrganizationMark } from "./dozo-organization-mark";
import { queryClient } from "./query/query";

const LOGO = "data:image/webp;base64,UklGRg==";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Home({ enabled = true, menu }: { enabled?: boolean; menu?: () => ReactNode }) {
  const title = dozoHomeTitle(useDozoOrganizationMark(enabled), menu);
  return <main>{title ? title() : "untitled"}</main>;
}

const render = (node: ReactNode) => act(async () => root.render(node));
const logo = () => container.querySelector("img");

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  queryClient.clear();
  state.read.mockReset();
  state.signal = undefined;
  state.enabled = [];
  state.focus = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("keeps the header as it was while the organization has no logo", async () => {
  state.read.mockResolvedValue({ name: "Acme", logo: null });
  await render(<Home />);
  await vi.waitFor(() => expect(state.read).toHaveBeenCalledWith("dozoOrganizationLogo/mark"));
  expect(container.textContent).toBe("untitled");
  await render(<Home menu={() => <b>Acme ▾</b>} />);
  expect(container.textContent).toBe("Acme ▾");
});

it("shows the logo, named for the organization, before the organization menu", async () => {
  state.read.mockResolvedValue({ name: "Acme", logo: LOGO });
  await render(<Home menu={() => <b>Acme ▾</b>} />);
  await vi.waitFor(() => expect(logo()?.getAttribute("src")).toBe(LOGO));
  expect(logo()?.getAttribute("alt")).toBe("Acme");
  expect(container.textContent).toBe("Acme ▾");
});

it("reads it again on the roster signal a change sends", async () => {
  state.read.mockResolvedValue({ name: "Acme", logo: null });
  await render(<Home />);
  await vi.waitFor(() => expect(state.read).toHaveBeenCalledTimes(1));
  state.read.mockResolvedValue({ name: "Acme", logo: LOGO });
  await act(async () => {
    await state.signal?.();
  });
  await vi.waitFor(() => expect(logo()?.getAttribute("src")).toBe(LOGO));
});

it("reads it again when the home screen comes back into focus", async () => {
  state.read.mockResolvedValue({ name: "Acme", logo: null });
  await render(<Home />);
  await vi.waitFor(() => expect(state.read).toHaveBeenCalledTimes(1));
  state.read.mockResolvedValue({ name: "Acme", logo: LOGO });
  await act(async () => state.focus?.());
  await vi.waitFor(() => expect(logo()?.getAttribute("src")).toBe(LOGO));
});

it("reads nothing while the home screen is not signed in", async () => {
  await render(<Home enabled={false} />);
  expect(state.read).not.toHaveBeenCalled();
  expect(state.enabled).toContain(false);
  expect(container.textContent).toBe("untitled");
});
