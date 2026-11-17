// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOT_COLOR_LIST } from "@rakazo/contracts";
import { DOZO_CHARACTERS } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as upstream from "./bot-avatar.js";
import {
  BOT_COLORS,
  BotAvatar,
  BotShapePreview,
  LogoAvatar,
  parseBotAvatar,
  Wordmark,
} from "./dozo-bot-avatar.js";
import { GroupAvatar } from "./group-avatar.js";
import * as ui from "./index.js";

const hexOf = (id: string) => BOT_COLOR_LIST.find((color) => color.id === id)?.hex as string;
const PHOTO = "data:image/png;base64,iVBORw0KGgo=";
const UPSTREAM_ART =
  '[class*="rakazo-organic-avatar"],[class*="rakazo-logo-avatar"],[class*="rakazo-bot-avatar"]';

const mounted: Array<() => void> = [];

function mount(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, rerender: (next: ReactNode) => act(() => root.render(next)) };
}

function avatarIn(container: HTMLElement) {
  const avatar = container.querySelector<HTMLElement>(".dozo-avatar");
  if (!avatar) throw new Error("no Dozo avatar");
  return avatar;
}

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.unstubAllGlobals();
});

describe("BotAvatar", () => {
  it("draws a Dozo character and none of upstream's art, whichever avatar set the bot has", () => {
    for (const avatarSet of [undefined, "organic", "rakazo"] as const) {
      const { container } = mount(
        <BotAvatar color={hexOf("blue")} identity="bot-1" avatarSet={avatarSet} size={40} />,
      );
      const avatar = avatarIn(container);
      expect(avatar.dataset.character).toBe("sora");
      expect(avatar.style.width).toBe("40px");
      expect(container.querySelectorAll("svg")).toHaveLength(1);
      expect(container.querySelector(UPSTREAM_ART)).toBeNull();
    }
  });

  it("lets the colour and a picked shape choose the character", () => {
    const of = (color: string) =>
      avatarIn(mount(<BotAvatar color={color} identity="bot-1" />).container).dataset.character;
    expect(of(hexOf("violet"))).toBe("kumo");
    expect(of(`${hexOf("violet")}::shape_2`)).toBe("hana");
    expect(DOZO_CHARACTERS).toContain(of(""));
  });

  it("keeps a saved photo as upstream draws it", () => {
    const { container } = mount(<BotAvatar color={PHOTO} identity="bot-1" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(PHOTO);
    expect(container.querySelector(".dozo-avatar")).toBeNull();
  });

  it.each([
    ["running", "working"],
    ["queued", "working"],
    ["waiting_input", "waiting"],
    ["failed", "idle"],
    ["completed", "idle"],
    [undefined, "idle"],
  ])("shows a %s run as %s", (status, state) => {
    const { container } = mount(<BotAvatar color="" identity="bot-1" status={status} />);
    expect(avatarIn(container).dataset.state).toBe(state);
  });

  it("lets an explicit activity win over the run status", () => {
    const of = (activity: "idle" | "writing" | "waiting" | "error") =>
      avatarIn(
        mount(<BotAvatar color="" identity="bot-1" status="running" activity={activity} />)
          .container,
      ).dataset.state;
    expect(of("idle")).toBe("idle");
    expect(of("error")).toBe("idle");
    expect(of("writing")).toBe("working");
    expect(of("waiting")).toBe("waiting");
  });

  it("keeps the same element in a list when a bot's state or colour changes", () => {
    const row = (status: string, color: string) => (
      <ul>
        {["bot-1", "bot-2", "bot-3"].map((id) => (
          <li key={id}>
            <BotAvatar color={color} identity={id} status={id === "bot-2" ? status : undefined} />
          </li>
        ))}
      </ul>
    );
    const { container, rerender } = mount(row("completed", hexOf("blue")));
    const before = [...container.querySelectorAll(".dozo-avatar")];
    rerender(row("running", hexOf("green")));
    const after = [...container.querySelectorAll<HTMLElement>(".dozo-avatar")];
    expect(after).toEqual(before);
    expect(after.map((avatar) => avatar.dataset.state)).toEqual(["idle", "working", "idle"]);
    expect(after.map((avatar) => avatar.dataset.character)).toEqual(["hana", "hana", "hana"]);
  });
});

describe("BotShapePreview", () => {
  it("offers the six characters for the editor's shapes and reports a click", () => {
    const onClick = vi.fn();
    const { container } = mount(
      DOZO_CHARACTERS.concat("sora", "kumo").map((name, shape) => (
        <BotShapePreview
          key={`${name}-${shape < 6}`}
          shapeIndex={shape}
          color={hexOf("red")}
          selected={shape === 1}
          onClick={onClick}
        />
      )),
    );
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => avatarIn(button).dataset.character)).toEqual([
      ...DOZO_CHARACTERS,
      "sora",
      "kumo",
    ]);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      ...DOZO_CHARACTERS,
      "sora",
      "kumo",
    ]);
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(
      buttons.map((_, shape) => String(shape === 1)),
    );
    act(() => buttons[3]?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(container.querySelector(UPSTREAM_ART)).toBeNull();
  });

  it("previews a bot without a shape by its colour, under the label it is given", () => {
    const { container } = mount(
      <>
        <BotShapePreview identity="bot-9" label="Shape 1" color={hexOf("cyan")} />
        <BotShapePreview color={hexOf("green")} />
      </>,
    );
    const [labelled, bare] = [...container.querySelectorAll("button")];
    expect(labelled?.getAttribute("aria-label")).toBe("Shape 1");
    expect(avatarIn(labelled as HTMLElement).dataset.character).toBe("mochi");
    expect(bare?.getAttribute("aria-label")).toBe("hana");
    expect(bare?.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("LogoAvatar and Wordmark", () => {
  it("draws the sign-in mascot as Sora, awake, at the size asked for", () => {
    const { container } = mount(
      <LogoAvatar size={74} avatarValue={hexOf("blue")} activity="waiting" motion={false} />,
    );
    const avatar = avatarIn(container);
    expect(avatar.dataset.character).toBe("sora");
    expect(avatar.dataset.state).toBe("waiting");
    expect(avatar.style.width).toBe("74px");
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(UPSTREAM_ART)).toBeNull();
  });

  it("labels the mascot when asked and sleeps by default", () => {
    const { container } = mount(<LogoAvatar identity="bot-1" label="Scout" className="mx-auto" />);
    const avatar = avatarIn(container);
    expect(avatar.getAttribute("aria-label")).toBe("Scout");
    expect(avatar.dataset.state).toBe("idle");
    expect(avatar.style.width).toBe("38px");
    expect(avatar.classList.contains("mx-auto")).toBe(true);
  });

  it("writes the wordmark as text", () => {
    const { container } = mount(<Wordmark className="ms-2" />);
    const mark = container.querySelector(".dozo-wordmark");
    expect(mark?.textContent).toBe("dozo");
    expect(mark?.classList.contains("ms-2")).toBe(true);
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("the wrapper in place of upstream's module", () => {
  it("passes upstream's other exports through unchanged", () => {
    expect(BOT_COLORS).toBe(upstream.BOT_COLORS);
    expect(parseBotAvatar).toBe(upstream.parseBotAvatar);
    expect(BotAvatar).not.toBe(upstream.BotAvatar);
  });

  it("is what the package exports", () => {
    expect(ui.BotAvatar).toBe(BotAvatar);
    expect(ui.BotShapePreview).toBe(BotShapePreview);
    expect(ui.LogoAvatar).toBe(LogoAvatar);
    expect(ui.Wordmark).toBe(Wordmark);
  });

  it("draws the members of a group avatar", () => {
    const members = ["bot-1", "bot-2", "bot-3"].map((botId) => ({ botId, color: hexOf("blue") }));
    for (const count of [1, 2, 3]) {
      const { container } = mount(<GroupAvatar members={members.slice(0, count)} />);
      expect(container.querySelectorAll(".dozo-avatar")).toHaveLength(count);
      expect(container.querySelector(UPSTREAM_ART)).toBeNull();
    }
  });
});

describe("dozo-shell.css", () => {
  const css = readFileSync(join(import.meta.dirname, "dozo-shell.css"), "utf8");
  const styles = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");

  it("is imported by the package stylesheet, after the tokens", () => {
    expect(styles.indexOf('@import "./dozo-shell.css";')).toBeGreaterThan(
      styles.indexOf("ui-tokens/css"),
    );
  });

  it("writes one colour, the seal, and takes every other from a token or the avatar", () => {
    const hex = css.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(hex).toHaveLength(2);
    expect(css).toMatch(/--dozo-seal: light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\);/i);
    expect(css).toContain("var(--dozo-tile)");
  });

  it("switches the sidebar pattern with one variable", () => {
    expect(css.match(/--dozo-seigaiha:/g)).toHaveLength(1);
    expect(css).toContain("opacity: var(--dozo-seigaiha);");
  });

  it("adds no motion and no !important", () => {
    expect(css).not.toMatch(/\b(?:animation|transition)\b\s*:/);
    expect(css).not.toContain("!important");
  });

  it("leaves the avatar unpositioned, which the tinted row relies on", () => {
    const avatar = readFileSync(join(import.meta.dirname, "dozo-avatar.css"), "utf8");
    expect(avatar).not.toMatch(/\.dozo-avatar\s*\{[^}]*position\s*:/);
  });
});
