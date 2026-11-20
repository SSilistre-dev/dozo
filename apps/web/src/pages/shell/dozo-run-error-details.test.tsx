// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const me = vi.hoisted(() => ({ value: { isAdmin: false } as { isAdmin: boolean } | null }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
const billing = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../../components/SubscriptionGate", () => ({
  useBilling: () => ({ status: billing.value }),
}));
vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({
    me: { queryOptions: () => ({ queryKey: ["me"], queryFn: async () => me.value }) },
  }),
}));

import { DozoRunErrorDetails, planLimitCode } from "./dozo-run-error-details";

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

async function render(details = raw) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DozoRunErrorDetails details={details} />
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

it("shows a plan limit's code instead of the server's English sentence", async () => {
  me.value = { isAdmin: true };
  const shown = async () =>
    vi.waitFor(() => {
      const pre = container.querySelector("pre");
      if (!pre) throw new Error("not shown yet");
      return pre.textContent;
    });
  billing.value = { state: "active", funding: "byok", byokTier: "standard" };
  await render("No computer hours left.");
  expect(await shown()).toBe("computer_not_in_plan");
  billing.value = { state: "active", funding: "byok", byokTier: "pro" };
  await render("No computer hours left. The computer was saved and stopped.");
  expect(await shown()).toBe("computer_hours_used");
  await render("All computers are busy. Try again shortly.");
  expect(await shown()).toBe("COMPUTERS_BUSY");
  billing.value = null;
  expect(planLimitCode(undefined, null)).toBeNull();
  expect(planLimitCode(raw, null)).toBeNull();
});

it("shows nothing where no query client is set up", async () => {
  me.value = { isAdmin: true };
  await act(async () => root.render(<DozoRunErrorDetails details={raw} />));
  expect(container.innerHTML).toBe("");
});
