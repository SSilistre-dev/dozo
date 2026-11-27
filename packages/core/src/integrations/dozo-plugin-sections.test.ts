import { describe, expect, it } from "vitest";
import { pluginsNotListedAbove } from "./dozo-plugin-sections.js";

describe("pluginsNotListedAbove", () => {
  const row = (id: string) => ({ id });

  it("leaves out a plugin the Recommended section already lists", () => {
    expect(pluginsNotListedAbove([row("a"), row("b"), row("c")], [row("b")])).toEqual([
      row("a"),
      row("c"),
    ]);
  });

  it("keeps every plugin when nothing is listed above", () => {
    expect(pluginsNotListedAbove([row("a")], [])).toEqual([row("a")]);
  });
});
