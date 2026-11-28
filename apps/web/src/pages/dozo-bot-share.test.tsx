// @vitest-environment jsdom

import type { DozoBotDefinition } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  publish: vi.fn(),
  status: vi.fn(),
  revoke: vi.fn(),
  open: vi.fn(),
  clone: vi.fn(),
  spaces: vi.fn(),
  selectSpace: vi.fn(),
  toastError: vi.fn(),
  toast: vi.fn(),
  writeClipboard: vi.fn(),
}));

vi.mock("../lib/query/rpc", () => {
  const rpc = {
    dozoBotShares: {
      preview: api.preview,
      publish: api.publish,
      status: api.status,
      revoke: api.revoke,
      open: api.open,
      clone: api.clone,
    },
    spaces: { list: api.spaces },
  };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => "space-1",
    selectSpace: api.selectSpace,
  };
});
vi.mock("../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings.join(""),
    i18n: { date: (date: Date) => date.toISOString().slice(0, 10) },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", async (load) => ({
  ...(await load<typeof import("@rakazo/ui-web")>()),
  toast: api.toast,
  writeClipboard: api.writeClipboard,
  BotAvatar: ({ color }: { color: string }) => <i data-avatar={color} />,
  ContextMenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  OptionSelect: ({
    options,
    onValueChange,
  }: {
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
  }) => (
    <select aria-label="space" onChange={(event) => onValueChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("./shell/bots/bot-settings-sections", () => ({
  SwitchRow: ({
    label,
    checked,
    onChange,
  }: {
    label: ReactNode;
    checked: boolean;
    onChange: (on: boolean) => void;
  }) => (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      {label}
    </button>
  ),
}));

import { QueryUserProvider } from "../lib/query/query";
import { DozoBotSharePage } from "./dozo-bot-share-page";
import { DOZO_SHARE_RENDERERS } from "./dozo-share-renderers";
import { DozoSurfaceHost, openDozoSurface } from "./dozo-surfaces";
import { DozoBotMenuItems } from "./shell/dozo-bot-extensions";

const TOKEN = "C".repeat(43);
const definition: DozoBotDefinition = {
  name: "Gardener",
  avatar: { color: "#22aa55", avatarSet: "organic" },
  instructions: "Water the plants.\n<b>not markup</b>",
  description: "Knows plants",
  routines: [{ name: "Morning", prompt: "Look at the garden", crons: ["0 8 * * *", "0 20 * * *"] }],
};
/** Every field at its limit, each ending in a mark the screen must still show. */
const atLimit: DozoBotDefinition = {
  ...definition,
  instructions: `${"i".repeat(19_996)}END1`,
  description: `${"d".repeat(3_996)}END2`,
  routines: Array.from({ length: 10 }, (_, index) => ({
    name: `R${index}`,
    prompt: `${"p".repeat(3_996)}E${index}`.padEnd(4000, "x"),
    crons: ["0 8 * * *"],
  })),
};
const FINGERPRINT = "f".repeat(64);
const shown = { definition, fingerprint: FINGERPRINT, hasPicture: false };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(node: ReactNode, user: string | null = "user-1", path = "/app") {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <QueryUserProvider value={user}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/app/:botId" element={<p>opened chat</p>} />
              <Route path="*" element={node} />
            </Routes>
          </MemoryRouter>
        </QueryUserProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function settle() {
  await act(async () => {});
}

const text = () => document.body.textContent ?? "";
function button(name: string) {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent === name);
  if (!found) throw new Error(`no button ${name} in: ${text()}`);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.preview.mockResolvedValue(shown);
  api.status.mockResolvedValue({ link: null });
  api.spaces.mockResolvedValue({ spaces: [{ id: "space-1", name: "Home" }] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the owner's menu item", () => {
  const menu = (
    <DozoBotMenuItems rpc={{} as never} botId="bot-1" name="Gardener" onClose={vi.fn()} />
  );

  it("shows for the bot's owner and opens the review", async () => {
    await render(
      <>
        <DozoSurfaceHost />
        {menu}
      </>,
    );
    await vi.waitFor(() => expect(text()).toContain("Share link"));
    await click("Share link");
    await vi.waitFor(() => expect(api.preview).toHaveBeenCalled());
    await vi.waitFor(() => expect(text()).toContain("Water the plants."));
  });

  it("stays hidden when the server refuses the status read", async () => {
    api.status.mockRejectedValue(new Error("not found"));
    await render(menu);
    expect(text()).not.toContain("Share link");
  });
});

describe("the owner's review", () => {
  async function open() {
    await render(<DozoSurfaceHost />);
    await act(async () => openDozoSurface("bot-share", { botId: "bot-1" }));
    await vi.waitFor(() => expect(text()).toContain("Water the plants."));
  }

  it("shows the exact text as text, never markup", async () => {
    await open();
    expect(text()).toContain("<b>not markup</b>");
    expect(document.querySelector("b")).toBeNull();
    expect(text()).toContain("Knows plants");
    expect(text()).toContain("Morning0 8 * * *, 0 20 * * *Look at the garden");
    expect(text()).not.toContain("Include picture");
  });

  it("gives each part its own text direction", async () => {
    await open();
    const parts = [...document.querySelectorAll("[dir=auto]")].map((node) => node.textContent);
    expect(parts).toEqual([
      "Gardener",
      definition.instructions,
      "Knows plants",
      "Morning",
      "0 8 * * *, 0 20 * * *",
      "Look at the garden",
    ]);
  });

  it("shows every field whole at its limit, routine prompts included", async () => {
    api.preview.mockResolvedValue({ ...shown, definition: atLimit });
    await render(<DozoSurfaceHost />);
    await act(async () => openDozoSurface("bot-share", { botId: "bot-1" }));
    await vi.waitFor(() => expect(text()).toContain(atLimit.instructions));
    expect(text()).toContain(atLimit.description);
    for (const routine of atLimit.routines) expect(text()).toContain(routine.prompt);
  });

  it("publishes what was shown and offers the link to copy", async () => {
    api.publish.mockResolvedValue({
      url: "https://app.example.test/s/x",
      expiresAt: "2026-12-28T00:00:00.000Z",
    });
    api.writeClipboard.mockResolvedValue(true);
    await open();
    api.status.mockResolvedValue({ link: { id: "l1", expiresAt: "2026-12-28T00:00:00.000Z" } });
    await click("Create link");
    expect(api.publish).toHaveBeenCalledWith({
      botId: "bot-1",
      includePicture: false,
      fingerprint: FINGERPRINT,
    });
    await vi.waitFor(() => expect(text()).toContain("Link expires 2026-12-28"));
    expect(document.querySelector<HTMLInputElement>("input")!.value).toBe(
      "https://app.example.test/s/x",
    );
    await click("Copy link");
    expect(api.toast).toHaveBeenCalledWith("Copied");
    api.writeClipboard.mockResolvedValue(false);
    await click("Copy link");
    expect(api.toastError).toHaveBeenCalledWith("Could not copy");
  });

  it("asks again with the new text when the bot changed meanwhile", async () => {
    api.publish.mockRejectedValue(
      Object.assign(new Error("changed"), { code: "BOT_SHARE_CHANGED" }),
    );
    await open();
    await click("Create link");
    await vi.waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    expect(api.toastError).toHaveBeenCalledWith("Could not share", expect.any(Error));
  });

  it("reports a publish the server refuses", async () => {
    api.publish.mockRejectedValue(new Error("down"));
    await open();
    await click("Create link");
    await vi.waitFor(() =>
      expect(api.toastError).toHaveBeenCalledWith("Could not share", expect.any(Error)),
    );
    expect(api.preview).toHaveBeenCalledTimes(1);
  });

  it("includes the picture only when ticked", async () => {
    api.preview.mockResolvedValue({ ...shown, hasPicture: true });
    await open();
    await click("Include picture");
    await vi.waitFor(() =>
      expect(api.preview).toHaveBeenCalledWith(
        { botId: "bot-1", includePicture: true },
        expect.anything(),
      ),
    );
  });

  it("revokes a live link, and offers a new one in its place", async () => {
    api.status.mockResolvedValue({ link: { id: "l1", expiresAt: "2026-12-28T00:00:00.000Z" } });
    api.revoke.mockResolvedValue({ revoked: true });
    await open();
    await vi.waitFor(() => expect(text()).toContain("Create new link"));
    api.status.mockResolvedValue({ link: null });
    await click("Revoke link");
    expect(api.revoke).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(text()).toContain("Revoke link?"));
    await click("Revoke");
    expect(api.revoke).toHaveBeenCalledWith({ botId: "bot-1" });
    await vi.waitFor(() => expect(text()).toContain("Create link"));
  });

  it("says when the bot is too large to share", async () => {
    api.preview.mockRejectedValue(Object.assign(new Error("big"), { code: "BOT_SHARE_TOO_LARGE" }));
    await render(<DozoSurfaceHost />);
    await act(async () => openDozoSurface("bot-share", { botId: "bot-1" }));
    await vi.waitFor(() => expect(text()).toContain("This bot is too large to share."));
  });

  it("shows a failure when the preview cannot be read", async () => {
    api.preview.mockRejectedValue(new Error("down"));
    await render(<DozoSurfaceHost />);
    await act(async () => openDozoSurface("bot-share", { botId: "bot-1" }));
    await vi.waitFor(() => expect(api.preview).toHaveBeenCalled());
    await settle();
    expect(text()).not.toContain("Water the plants.");
  });

  it("reports a revoke that fails", async () => {
    api.status.mockResolvedValue({ link: { id: "l1", expiresAt: "2026-12-28T00:00:00.000Z" } });
    api.revoke.mockRejectedValue(new Error("down"));
    await open();
    await vi.waitFor(() => expect(text()).toContain("Revoke link"));
    await click("Revoke link");
    await vi.waitFor(() => expect(text()).toContain("Revoke link?"));
    await click("Revoke");
    await vi.waitFor(() =>
      expect(api.toastError).toHaveBeenCalledWith("Could not revoke", expect.any(Error)),
    );
  });

  it("keeps a link when the person cancels the revoke", async () => {
    api.status.mockResolvedValue({ link: { id: "l1", expiresAt: "2026-12-28T00:00:00.000Z" } });
    await open();
    await vi.waitFor(() => expect(text()).toContain("Revoke link"));
    await click("Revoke link");
    await vi.waitFor(() => expect(text()).toContain("Revoke link?"));
    await click("Cancel");
    await vi.waitFor(() => expect(text()).not.toContain("Revoke link?"));
    expect(api.revoke).not.toHaveBeenCalled();
  });
});

describe("the shared page", () => {
  const publicPart = {
    name: "Gardener",
    avatar: { color: null, avatarSet: "organic" },
    instructionsExcerpt: "Water the plants.",
    routineNames: ["Morning"],
  };

  beforeEach(() => {
    window.history.replaceState(null, "", `/s/${TOKEN}`);
  });

  it("is drawn for the bot kind", async () => {
    expect(await DOZO_SHARE_RENDERERS.bot!()).toBe(DozoBotSharePage);
  });

  it("shows a signed-out reader the public part and a way to sign in", async () => {
    await render(<DozoBotSharePage payload={publicPart} />, null);
    expect(text()).toContain("Water the plants.");
    expect(text()).toContain("Morning");
    const link = document.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(`/sign-in?next=${encodeURIComponent(`/s/${TOKEN}`)}`);
    expect(api.open).not.toHaveBeenCalled();
  });

  it("leaves out the parts a bot does not have", async () => {
    await render(
      <DozoBotSharePage payload={{ ...publicPart, instructionsExcerpt: "", routineNames: [] }} />,
      null,
    );
    expect(text()).toContain("Gardener");
    expect(text()).not.toContain("Instructions");
    expect(text()).not.toContain("Routines");
  });

  it("refuses a payload of another shape", async () => {
    await render(<DozoBotSharePage payload={{ name: 1 }} />, null);
    expect(text()).not.toContain("Gardener");
  });

  it("shows a signed-in reader the whole definition and makes their copy", async () => {
    api.open.mockResolvedValue({ definition, fingerprint: FINGERPRINT });
    api.clone.mockResolvedValue({ bot: { id: "copy-1" } });
    await render(<DozoBotSharePage payload={publicPart} />);
    await vi.waitFor(() => expect(text()).toContain("<b>not markup</b>"));
    // The prompt runs with the reader's tools, so it is on screen before they confirm.
    expect(text()).toContain("Look at the garden");
    expect(api.open).toHaveBeenCalledWith({ token: TOKEN }, expect.anything());
    expect(document.querySelector("select")).toBeNull();
    await click("Make a copy");
    const [input] = api.clone.mock.calls[0]!;
    expect(input).toMatchObject({ token: TOKEN, fingerprint: FINGERPRINT });
    expect(input.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await vi.waitFor(() => expect(text()).toContain("opened chat"));
    expect(api.selectSpace).not.toHaveBeenCalled();
  });

  it("shows a signed-in reader every field whole at its limit", async () => {
    api.open.mockResolvedValue({ definition: atLimit, fingerprint: FINGERPRINT });
    await render(<DozoBotSharePage payload={publicPart} />);
    await vi.waitFor(() => expect(text()).toContain(atLimit.instructions));
    expect(text()).toContain(atLimit.description);
    for (const routine of atLimit.routines) expect(text()).toContain(routine.prompt);
  });

  it("offers the reader's Spaces when they have several", async () => {
    api.open.mockResolvedValue({ definition, fingerprint: FINGERPRINT });
    api.spaces.mockResolvedValue({
      spaces: [
        { id: "space-1", name: "Home" },
        { id: "space-2", name: "Team" },
      ],
    });
    api.clone.mockResolvedValue({ bot: { id: "copy-2" } });
    await render(<DozoBotSharePage payload={publicPart} />);
    await vi.waitFor(() => expect(document.querySelectorAll("option")).toHaveLength(2));
    const select = document.querySelector("select")!;
    await act(async () => {
      select.value = "space-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Make a copy");
    expect(api.selectSpace).toHaveBeenCalledWith("space-2");
  });

  it("reads the definition again when it changed, and reports a refused copy", async () => {
    api.open.mockResolvedValue({ definition, fingerprint: FINGERPRINT });
    api.clone.mockRejectedValue(Object.assign(new Error("changed"), { code: "BOT_SHARE_CHANGED" }));
    await render(<DozoBotSharePage payload={publicPart} />);
    await vi.waitFor(() => expect(text()).toContain("Make a copy"));
    await click("Make a copy");
    await vi.waitFor(() => expect(api.open).toHaveBeenCalledTimes(2));
    expect(api.toastError).toHaveBeenCalledWith("Could not make a copy", expect.any(Error));
  });

  it("reports a copy a plan limit refuses", async () => {
    api.open.mockResolvedValue({ definition, fingerprint: FINGERPRINT });
    api.clone.mockRejectedValue(new Error("limit"));
    await render(<DozoBotSharePage payload={publicPart} />);
    await vi.waitFor(() => expect(text()).toContain("Make a copy"));
    await click("Make a copy");
    await vi.waitFor(() =>
      expect(api.toastError).toHaveBeenCalledWith("Could not make a copy", expect.any(Error)),
    );
    expect(api.open).toHaveBeenCalledTimes(1);
  });

  it("shows a failure when the link stopped opening", async () => {
    api.open.mockRejectedValue(new Error("not found"));
    await render(<DozoBotSharePage payload={publicPart} />);
    await vi.waitFor(() => expect(text()).not.toContain("Make a copy"));
  });
});
