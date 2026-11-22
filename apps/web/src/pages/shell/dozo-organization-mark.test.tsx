// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ mark: vi.fn(), desktop: undefined as unknown }));

vi.mock("../../lib/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof Desktop>()),
  desktopBridge: () => api.desktop,
}));
vi.mock("../../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoOrganizationLogo: {
      mark: {
        queryOptions: () => ({
          queryKey: [["dozoOrganizationLogo", "mark"], { type: "query" }],
          queryFn: () => api.mark(),
        }),
      },
    },
  }),
}));

import type * as Desktop from "../../lib/desktop";
import type * as Query from "../../lib/query";
import { DozoSidebarStart, dozoOrganizationMarkChanged } from "./dozo-organization-mark";

const LOGO = "data:image/webp;base64,UklGRg==";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

const chrome = <span data-testid="chrome" />;

async function render(node: ReactNode) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  await vi.waitFor(() => expect(api.mark).toHaveBeenCalled());
}

const logo = () => container.querySelector("img");
const hasChrome = () => Boolean(container.querySelector('[data-testid="chrome"]'));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.mark.mockReset();
  api.desktop = undefined;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps the header as it is when the organization has no logo", async () => {
  api.mark.mockResolvedValue({ name: "Acme", logo: null });
  await render(<DozoSidebarStart chrome={chrome} mini={false} />);
  expect(hasChrome()).toBe(true);
  expect(logo()).toBeNull();
});

it("shows the logo, named for the organization, in place of the web's spacer", async () => {
  api.mark.mockResolvedValue({ name: "Acme", logo: LOGO });
  await render(<DozoSidebarStart chrome={chrome} mini={false} />);
  await vi.waitFor(() => expect(logo()?.getAttribute("src")).toBe(LOGO));
  expect(logo()?.getAttribute("alt")).toBe("Acme");
  expect(hasChrome()).toBe(false);
});

it("keeps a desktop window's controls before the logo", async () => {
  api.desktop = { platform: "linux", nativeWindowFrame: false };
  api.mark.mockResolvedValue({ name: "Acme", logo: LOGO });
  await render(<DozoSidebarStart chrome={chrome} mini={false} />);
  await vi.waitFor(() => expect(logo()).not.toBeNull());
  expect(hasChrome()).toBe(true);
});

it("shows no logo in the narrow sidebar", async () => {
  api.mark.mockResolvedValue({ name: "Acme", logo: LOGO });
  await render(<DozoSidebarStart chrome={chrome} mini />);
  expect(logo()).toBeNull();
  expect(hasChrome()).toBe(true);
});

it("reads the logo again on the roster signal a change sends", async () => {
  api.mark.mockResolvedValue({ name: "Acme", logo: null });
  await render(<DozoSidebarStart chrome={chrome} mini={false} />);
  api.mark.mockResolvedValue({ name: "Acme", logo: LOGO });
  await act(async () => dozoOrganizationMarkChanged(client));
  await vi.waitFor(() => expect(logo()?.getAttribute("src")).toBe(LOGO));
  expect(api.mark).toHaveBeenCalledTimes(2);
});
