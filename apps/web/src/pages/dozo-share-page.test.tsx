// @vitest-environment jsdom
import { DOZO_SHARE_LINK_API_PREFIX } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/PageLoading", () => ({ PageLoading: () => <p>loading</p> }));

import { DozoSharePage } from "./dozo-share-page";

const TOKEN = "A".repeat(43);
const renderers = {
  note:
    async () =>
    ({ payload }: { payload: unknown }) => <p>note {JSON.stringify(payload)}</p>,
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function open(token: string) {
  const client = new QueryClient();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DozoSharePage token={token} notFound={<p>not found</p>} renderers={renderers} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(async () => {
    await act(async () => undefined);
    expect(host.textContent).not.toBe("loading");
  });
}

const answer = (status: number, body: unknown = {}) =>
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));

it("draws a live link with its kind's renderer, signed out and out of search results", async () => {
  answer(200, { kind: "note", payload: { n: 1 } });
  await open(TOKEN);
  expect(host.textContent).toBe('note {"n":1}');
  expect(fetchMock).toHaveBeenCalledWith(`${DOZO_SHARE_LINK_API_PREFIX}${TOKEN}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
    "noindex, nofollow",
  );
});

it("shows the 404 for a link the server refuses", async () => {
  answer(404);
  await open(TOKEN);
  expect(host.textContent).toBe("not found");
});

it("shows the 404 without asking for a string that cannot be a token", async () => {
  await open("short");
  expect(host.textContent).toBe("not found");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("shows the 404 for a kind this build cannot draw", async () => {
  answer(200, { kind: "constructor", payload: {} });
  await open(TOKEN);
  expect(host.textContent).toBe("not found");
});

it("says it could not load when the server fails", async () => {
  answer(500);
  await open(TOKEN);
  expect(host.textContent).toBe("Could not load");
});
