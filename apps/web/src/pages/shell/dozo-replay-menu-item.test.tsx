// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => vi.fn());
vi.mock("../dozo-surfaces", () => ({ openDozoSurface: opened }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  DropdownMenuItem: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" role="menuitem" {...props}>
      {children}
    </button>
  ),
}));

import type { DozoMessageMenuItemProps } from "./dozo-message-extensions";
import { DozoMessageMenuItems } from "./dozo-message-extensions";
import { DozoReplayMenuItem } from "./dozo-replay-menu-item";

const reply: ThreadMessage = {
  id: "m-1",
  threadId: "t-1",
  seq: 2,
  role: "bot",
  botId: "b-1",
  runId: "r-1",
  blocks: [{ kind: "steps", steps: [{ label: "Browser navigate", count: 1 }] }],
  createdAt: "2026-11-20T10:00:00.000Z",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(
  message: ThreadMessage,
  path = "/app/b-1",
  Item: (props: DozoMessageMenuItemProps) => ReactNode = DozoMessageMenuItems,
) {
  const element = <Item message={message} menuOpen />;
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/:botId" element={element} />
          <Route path="/app/g/:groupId" element={element} />
        </Routes>
      </MemoryRouter>,
    );
  });
}
const item = () => container.querySelector('[role="menuitem"]');

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  opened.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("offers Share replay on the bot's reply with steps in its own chat, and opens the review", async () => {
  await render(reply);
  await vi.waitFor(() => expect(item()?.textContent).toBe("Share replay"));
  await act(async () => (item() as HTMLElement).click());
  expect(opened).toHaveBeenCalledWith("replay", { messageId: "m-1" });
});

it.each([
  [
    "a reply without steps",
    { ...reply, blocks: [{ kind: "text" as const, text: "Hi" }] },
    "/app/b-1",
  ],
  ["the person's own message", { ...reply, role: "user" as const }, "/app/b-1"],
  ["another bot's chat", reply, "/app/b-2"],
  ["a group chat", reply, "/app/g/g-1"],
])("offers nothing on %s", async (_name, message, path) => {
  await render(message, path, DozoReplayMenuItem);
  expect(item()).toBeNull();
});
