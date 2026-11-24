// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  frameColour,
  titleWithColour,
  titleWithCount,
  useDesktopBadge,
} from "./dozo-desktop-badge";

let root: Root;
function Harness({ count }: { count: number }) {
  useDesktopBadge(count);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.title = "Dozo";
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("puts only the count in front of the title, and nothing when it is zero", () => {
  expect(titleWithCount("Dozo", 3)).toBe("(3) Dozo");
  expect(titleWithCount("(3) Dozo", 12)).toBe("(12) Dozo");
  expect(titleWithCount("(12) Dozo", 0)).toBe("Dozo");
  expect(titleWithCount("Dozo", 0)).toBe("Dozo");
  // Never anything but a whole number.
  for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -2, 0.5]) {
    expect(titleWithCount("(4) Dozo", bad)).toBe("Dozo");
  }
  expect(titleWithCount("Dozo", 2.7)).toBe("(2) Dozo");
  // A title that only looks like a count somewhere else is left alone.
  expect(titleWithCount("Dozo (2)", 1)).toBe("(1) Dozo (2)");
});

it("follows the count and clears it when the shell goes", () => {
  for (const [count, title] of [
    [2, "(2) Dozo"],
    [5, "(5) Dozo"],
    [0, "Dozo"],
    [1, "(1) Dozo"],
  ] as const) {
    act(() => root.render(<Harness count={count} />));
    expect(document.title).toBe(title);
  }
  act(() => root.render(null));
  expect(document.title).toBe("Dozo");
});

it("keeps the frame colour at the end, so the count stays first", () => {
  expect(titleWithCount("Dozo #0e0e10", 3)).toBe("(3) Dozo #0e0e10");
  expect(titleWithCount("(3) Dozo #0e0e10", 0)).toBe("Dozo #0e0e10");
  expect(titleWithColour("(3) Dozo", "#ffffff")).toBe("(3) Dozo #ffffff");
  expect(titleWithColour("(3) Dozo #0e0e10", "#ffffff")).toBe("(3) Dozo #ffffff");
  expect(titleWithColour("(3) Dozo #0e0e10", null)).toBe("(3) Dozo");
});

it("is read by an app that reads the count from the start of the title", () => {
  // The unread count as every released desktop app reads it (dozo/desktop/src/alerts.rs,
  // unread_count): a number in brackets at the very start, then the end or a space.
  const released = (title: string) => {
    const match = title.match(/^\((\d+)\+?\)(?: |$)/);
    return match ? Number(match[1]) : 0;
  };
  for (const [count, colour] of [
    [3, "#0e0e10"],
    [12, "#ffffff"],
    [0, "#fafafa"],
  ] as const) {
    expect(released(titleWithColour(titleWithCount("Dozo", count), colour))).toBe(count);
  }
});

it("takes only a hex theme colour", () => {
  expect(frameColour("#0A0A0A")).toBe("#0a0a0a");
  expect(frameColour(" #fff ")).toBe("#ffffff");
  for (const bad of [null, undefined, "", "red", "rgb(1, 2, 3)", "#12345", "#1234567", "0a0a0a"]) {
    expect(frameColour(bad)).toBeNull();
  }
});

it("follows the theme-color in the desktop app's window only", async () => {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "theme-color");
  meta.setAttribute("content", "#0a0a0a");
  document.head.append(meta);
  try {
    act(() => root.render(<Harness count={2} />));
    expect(document.title).toBe("(2) Dozo");
    act(() => root.unmount());

    vi.stubGlobal("dozoDesktopShell", true);
    root = createRoot(document.createElement("div"));
    act(() => root.render(<Harness count={2} />));
    expect(document.title).toBe("(2) Dozo #0a0a0a");
    meta.setAttribute("content", "#ffffff");
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.title).toBe("(2) Dozo #ffffff");
    act(() => root.render(<Harness count={0} />));
    expect(document.title).toBe("Dozo #ffffff");
    act(() => root.render(null));
    expect(document.title).toBe("Dozo");
  } finally {
    meta.remove();
  }
});
