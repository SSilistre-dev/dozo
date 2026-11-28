// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: ({ identity, color }: { identity: string; color: string }) => (
    <i data-identity={identity} data-color={color} />
  ),
}));

import { DOZO_SHARE_RENDERERS } from "./dozo-share-renderers";
import { DozoStatsCard } from "./dozo-stats-card";

const card = {
  name: "<b>Pip</b>",
  character: "mochi",
  color: null,
  stats: { tasksFinished: 1200, routineRuns: 2, skillsLearned: 0, daysActive: 7, more: true },
};
let root: ReturnType<typeof createRoot> | undefined;

async function draw(payload: unknown) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root?.render(<DozoStatsCard payload={payload} />));
  return container;
}
afterEach(() => act(async () => root?.unmount()));

describe("the stats card", () => {
  it("is what a stats link draws", async () => {
    expect(await DOZO_SHARE_RENDERERS.stats?.()).toBe(DozoStatsCard);
  });

  it("shows the face, the name as text and the four numbers", async () => {
    const page = await draw(card);
    expect(page.querySelector("h1")?.textContent).toBe("<b>Pip</b>");
    expect(page.querySelector("b")).toBeNull();
    expect(page.querySelector("i")?.getAttribute("data-color")).toBe("white");
    expect(page.textContent).toContain("1,200+");
    expect(page.querySelector("bdi")?.getAttribute("dir")).toBe("auto");
    expect(page.querySelectorAll("dd")).toHaveLength(4);
  });

  it("draws nothing for a payload of another shape", async () => {
    expect((await draw({ name: 1 })).textContent).toBe("");
  });
});
