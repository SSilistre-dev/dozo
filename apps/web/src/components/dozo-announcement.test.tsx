// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ announcement: vi.fn(), locale: "en" }));

vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoSiteSettings: {
      announcement: {
        queryOptions: () => ({ queryKey: ["announcement"], queryFn: () => api.announcement() }),
      },
    },
  }),
}));
// Its own test covers the reminder; here it would read the real session.
vi.mock("./dozo-verify-reminder", () => ({ DozoVerifyReminder: () => null }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: api.locale } }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import type * as Query from "../lib/query";
import { announcementText, DozoAnnouncementLayout, dozoSiteChanged } from "./dozo-announcement";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <Routes>
            <Route element={<DozoAnnouncementLayout />}>
              <Route path="/" element={<main>App</main>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

const band = () => container.querySelector('[role="status"]');

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.announcement.mockReset();
  api.locale = "en";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the announcement band", () => {
  it("shows the announcement in the app's language, one line under the page", async () => {
    api.locale = "tr";
    api.announcement.mockResolvedValue({ en: "Maintenance tonight", tr: "Bu gece bakım" });
    await render();
    await vi.waitFor(() => expect(band()?.textContent).toBe("Bu gece bakım"));
    expect(band()?.className).toContain("truncate");
    expect(container.querySelector("main")?.textContent).toBe("App");
  });

  it("shows nothing without an announcement", async () => {
    api.announcement.mockResolvedValue({ en: null, tr: null });
    await render();
    await vi.waitFor(() => expect(api.announcement).toHaveBeenCalled());
    expect(band()).toBeNull();
    expect(container.querySelector("main")?.textContent).toBe("App");
  });
});

describe("the live stream's signal", () => {
  it("reads the site settings again, and nothing else", async () => {
    const client = new QueryClient();
    const keys = [
      [["user-1", "space-1", "dozoSiteSettings", "announcement"], { type: "query" }],
      [["user-1", "space-1", "dozoSiteSettings", "get"], { type: "query" }],
      [["user-1", "space-1", "runs", "list"], { type: "query" }],
    ];
    for (const key of keys) client.setQueryData(key, "cached");
    await dozoSiteChanged(client);
    const stale = keys.map((key) => client.getQueryState(key)?.isInvalidated);
    expect(stale).toEqual([true, true, false]);
  });
});

describe("which text is shown", () => {
  it("prefers the app's language and falls back to the other", () => {
    expect(announcementText(undefined, "en")).toBeNull();
    expect(announcementText({ en: "Hi", tr: "Selam" }, "en")).toBe("Hi");
    expect(announcementText({ en: "Hi", tr: "Selam" }, "tr")).toBe("Selam");
    expect(announcementText({ en: null, tr: "Selam" }, "de")).toBe("Selam");
    expect(announcementText({ en: "Hi", tr: null }, "tr")).toBe("Hi");
  });
});
