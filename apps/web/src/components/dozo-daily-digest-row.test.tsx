// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), bots: vi.fn(), toastError: vi.fn() }));

vi.mock("../lib/rpc", () => {
  const rpc = { dozoDailyDigest: { set: api.set } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoDailyDigest: {
      get: {
        key: () => ["digest"],
        queryOptions: () => ({ queryKey: ["digest"], queryFn: () => api.get() }),
      },
    },
    bots: {
      list: { queryOptions: () => ({ queryKey: ["bots"], queryFn: () => api.bots() }) },
    },
  }),
}));
vi.mock("../lib/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en-GB" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Label: ({ htmlFor, children, className }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor} className={className}>
      {children}
    </label>
  ),
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    id: string;
    disabled?: boolean;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      {...props}
    />
  ),
  toast: { error: api.toastError },
}));

import type * as Query from "../lib/query";
import { DozoDailyDigestRow } from "./dozo-daily-digest-row";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const ADA = { id: "bot-1", name: "Ada" };
const BOB = { id: "bot-2", name: "Bob" };
const MORNING = { botId: "bot-1", botName: "Ada", minute: 8 * 60 };

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DozoDailyDigestRow />
      </QueryClientProvider>,
    );
  });
}

const toggle = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]');
const select = (label: string) =>
  container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);

async function loaded() {
  await render();
  await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
}

async function choose(label: string, value: string) {
  const node = select(label);
  if (!node) throw new Error(`Missing ${label}`);
  await act(async () => {
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.bots.mockResolvedValue([ADA, BOB]);
  api.set.mockImplementation(async ({ digest }) => {
    const bot = [ADA, BOB].find((one) => one.id === digest?.botId);
    const saved = digest && bot ? { ...digest, botName: bot.name } : null;
    api.get.mockResolvedValue({ digest: saved });
    return { digest: saved };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows only its switch while off, named by its label", async () => {
  api.get.mockResolvedValue({ digest: null });
  await loaded();
  expect(toggle()?.checked).toBe(false);
  expect(container.querySelector(`label[for="${toggle()?.id}"]`)?.textContent).toBe("Daily digest");
  expect(container.querySelectorAll("select")).toHaveLength(0);
});

it("is not offered in a Space with no bot to write it", async () => {
  api.get.mockResolvedValue({ digest: null });
  api.bots.mockResolvedValue([]);
  await render();
  await vi.waitFor(() => expect(api.bots).toHaveBeenCalled());
  await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(container.querySelector('[data-testid="dozo-daily-digest"]')).toBeNull();
});

it("turns on at eight in the first bot's chat, then offers the time and the bot", async () => {
  api.get.mockResolvedValue({ digest: null });
  await loaded();
  await act(async () => toggle()?.click());
  expect(api.set).toHaveBeenCalledWith({ digest: { botId: "bot-1", minute: 480 } });
  await vi.waitFor(() => expect(toggle()?.checked).toBe(true));
  expect(select("Daily digest time")?.value).toBe("480");
  expect(select("Daily digest time")?.selectedOptions[0]?.textContent).toBe("8:00");
  expect(select("Daily digest bot")?.value).toBe("bot-1");
});

it("changes the time or the bot and keeps the other", async () => {
  api.get.mockResolvedValue({ digest: MORNING });
  await loaded();
  await choose("Daily digest time", "1200");
  expect(api.set).toHaveBeenCalledWith({ digest: { botId: "bot-1", minute: 1200 } });
  await vi.waitFor(() => expect(select("Daily digest time")?.value).toBe("1200"));
  await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
  await choose("Daily digest bot", "bot-2");
  expect(api.set).toHaveBeenLastCalledWith({ digest: { botId: "bot-2", minute: 1200 } });
});

it("asks for no bot when there is only one", async () => {
  api.get.mockResolvedValue({ digest: MORNING });
  api.bots.mockResolvedValue([ADA]);
  await loaded();
  expect(select("Daily digest bot")).toBeNull();
  expect(select("Daily digest time")).not.toBeNull();
});

it("keeps a bot from another Space and a time off the hour among the choices", async () => {
  api.get.mockResolvedValue({ digest: { botId: "bot-9", botName: "Cy", minute: 8 * 60 + 30 } });
  await loaded();
  expect(select("Daily digest bot")?.selectedOptions[0]?.textContent).toBe("Cy");
  expect(select("Daily digest time")?.value).toBe("510");
  expect(select("Daily digest time")?.options).toHaveLength(25);
});

it("shows no time for a schedule edited in the Routines list, and sets one", async () => {
  api.get.mockResolvedValue({ digest: { ...MORNING, minute: null } });
  await loaded();
  expect(select("Daily digest time")?.value).toBe("");
  await choose("Daily digest bot", "bot-2");
  expect(api.set).toHaveBeenCalledWith({ digest: { botId: "bot-2", minute: 480 } });
});

it("turns off", async () => {
  api.get.mockResolvedValue({ digest: MORNING });
  await loaded();
  await act(async () => toggle()?.click());
  expect(api.set).toHaveBeenCalledWith({ digest: null });
  await vi.waitFor(() => expect(container.querySelectorAll("select")).toHaveLength(0));
});

it("says so when the save fails, and shows the saved state again", async () => {
  api.get.mockResolvedValue({ digest: null });
  api.set.mockRejectedValue(new Error("down"));
  await loaded();
  await act(async () => toggle()?.click());
  await vi.waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith("Couldn't update the daily digest"),
  );
  await vi.waitFor(() => expect(toggle()?.checked).toBe(false));
});

it("stays off and still while the saved digest cannot be read", async () => {
  api.get.mockRejectedValue(new Error("down"));
  await render();
  await vi.waitFor(() => expect(toggle()?.disabled).toBe(true));
  expect(toggle()?.checked).toBe(false);
});
