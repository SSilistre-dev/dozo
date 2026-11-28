// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  toastError: vi.fn(),
  success: vi.fn(),
  plain: vi.fn(),
}));

vi.mock("../../lib/query/rpc", () => {
  const rpc = {
    dozoBotStats: { get: api.get },
    dozoShareLinks: { list: api.list, create: api.create, revoke: api.revoke },
  };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => "space-1",
  };
});
vi.mock("../../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en-GB" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: Record<string, unknown> & { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  toast: Object.assign(api.plain, { success: api.success }),
}));

import { QueryUserProvider } from "../../lib/query/query";
import DozoBotStats from "./dozo-bot-stats";

const STATS = { tasksFinished: 1200, routineRuns: 2, skillsLearned: 0, daysActive: 7 };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function draw() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <QueryUserProvider userId="user-1">
          <DozoBotStats botId="bot-1" spaceId="space-1" />
        </QueryUserProvider>
      </QueryClientProvider>,
    ),
  );
}
const click = (label: string) =>
  act(async () => {
    [...container.querySelectorAll("button")].find((node) => node.textContent === label)?.click();
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  document.body.append(container);
  for (const fn of Object.values(api)) fn.mockReset();
  api.get.mockResolvedValue(STATS);
  api.list.mockResolvedValue({ links: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("a bot's stats row", () => {
  it("shows nothing when the numbers are refused", async () => {
    api.get.mockRejectedValue(new Error("not found"));
    await draw();
    expect(container.textContent).toBe("");
  });

  it("shows the numbers and copies the card's link when it is made", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    api.create.mockResolvedValue({ url: "https://app.example.test/s/token" });
    await draw();
    expect(container.textContent).toContain("1,200");
    await click("Share card");
    expect(api.create).toHaveBeenCalledWith({ kind: "stats", targetId: "bot-1", days: 30 });
    expect(writeText).toHaveBeenCalledWith("https://app.example.test/s/token");
    expect(api.success).toHaveBeenCalledWith("Link copied");
  });

  it("shows the link itself when the clipboard refuses it", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    api.create.mockResolvedValue({ url: "https://app.example.test/s/token" });
    await draw();
    await click("Share card");
    expect(api.plain).toHaveBeenCalledWith("https://app.example.test/s/token");
  });

  it("says when the card could not be made", async () => {
    api.create.mockRejectedValue(new Error("limit"));
    await draw();
    await click("Share card");
    expect(api.toastError).toHaveBeenCalledWith("Could not share", expect.any(Error));
  });

  it("stops sharing this bot's cards, and says when it could not", async () => {
    api.list.mockResolvedValue({
      links: [
        { id: "a", kind: "stats", targetId: "bot-1" },
        { id: "b", kind: "stats", targetId: "bot-2" },
      ],
    });
    api.revoke.mockResolvedValueOnce({ revoked: true }).mockRejectedValueOnce(new Error("x"));
    await draw();
    await click("Stop sharing");
    expect(api.revoke).toHaveBeenCalledTimes(1);
    expect(api.revoke).toHaveBeenCalledWith({ id: "a" });
    api.revoke.mockRejectedValue(new Error("x"));
    await click("Stop sharing");
    expect(api.toastError).toHaveBeenCalledWith("Could not save", expect.any(Error));
  });
});
