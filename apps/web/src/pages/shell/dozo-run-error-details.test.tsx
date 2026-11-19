// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const me = vi.hoisted(() => ({ value: { isAdmin: false } as { isAdmin: boolean } | null }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({
    me: { queryOptions: () => ({ queryKey: ["me"], queryFn: async () => me.value }) },
  }),
}));

import { DozoRunErrorDetails } from "./dozo-run-error-details";

const raw = '429: {"message":"Too many requests","metadata":{"provider":"Example"}}';
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DozoRunErrorDetails details={raw} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(client.getQueryState(["me"])?.status).not.toBe("pending"));
  await act(async () => undefined);
}

it("keeps a run's raw failure from people who are not admins", async () => {
  me.value = { isAdmin: false };
  await render();
  expect(container.innerHTML).toBe("");
  me.value = null;
  await render();
  expect(container.innerHTML).toBe("");
});

it("shows it, folded, to the deployment's admins", async () => {
  me.value = { isAdmin: true };
  await render();
  const details = await vi.waitFor(() => {
    const found = container.querySelector("details");
    if (!found) throw new Error("not shown yet");
    return found;
  });
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")?.textContent).toBe("Details");
  expect(details.querySelector("pre")?.textContent).toBe(raw);
});

it("shows nothing where no query client is set up", async () => {
  me.value = { isAdmin: true };
  await act(async () => root.render(<DozoRunErrorDetails details={raw} />));
  expect(container.innerHTML).toBe("");
});
