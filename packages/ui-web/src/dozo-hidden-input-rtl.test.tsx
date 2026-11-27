// @vitest-environment jsdom
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { Input } from "./components/ui/input.js";

// Runs on the branded tree: a brand rule moves the show button and its room to the end side.

const classOf = (html: string, tag: "input" | "button") =>
  html.match(new RegExp(`<${tag}[^>]*class="([^"]*)"`))?.[1] ?? "";

it.each([
  ["default", "pe-9", "end-1"],
  ["xl", "pe-12", "end-2"],
] as const)("keeps a %s hidden field's text clear of the show button in right-to-left", (size, room, side) => {
  const html = renderToString(<Input type="password" size={size} />);
  const input = classOf(html, "input").split(" ");
  const button = classOf(html, "button").split(" ");

  expect(input).toContain(room);
  expect(button).toContain(side);
  expect([...input, ...button].filter((name) => /^(pr|right)-/.test(name))).toEqual([]);
});
