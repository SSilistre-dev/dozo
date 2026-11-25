import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { containerActionStep, workspaceTarget } from "./supervisor-logic.js";

// The bot's computer never asks before a click, a double click or open_path (dozo/README.md,
// "Commands on the bot's computer"), because on this image none of them can run a command: a file
// opens as a browser tab, and nothing installed runs a script or a .desktop file on a double click
// or types from an on-screen keyboard. If the image gains such a program, this fails and the rule
// has to be read again.

const dockerfile = readFileSync(
  path.resolve(import.meta.dirname, "../../computer/Dockerfile"),
  "utf8",
);

/** File managers, desktop-file openers and on-screen keyboards found in Debian. */
const LAUNCHERS = [
  "thunar",
  "pcmanfm",
  "nautilus",
  "nemo",
  "caja",
  "dolphin",
  "rox-filer",
  "spacefm",
  "xfe",
  "exo-utils",
  "libglib2.0-bin",
  "onboard",
  "florence",
  "xvkbd",
  "matchbox-keyboard",
  "cellwriter",
];

describe("what a click or open_path reaches on the bot's computer", () => {
  it("opens a workspace file, a script or a .desktop file too, as a browser tab", () => {
    for (const file of ["run.sh", "app.desktop", "notes/page.html"]) {
      const step = containerActionStep({ kind: "open", path: file }, ":1");
      const url = pathToFileURL(workspaceTarget(file), { windows: false }).href;
      expect(step).toEqual({ argv: ["env", "DISPLAY=:1", "rakazo-browser", url] });
    }
  });

  it("hands only an http(s) address to the system opener", () => {
    expect(containerActionStep({ kind: "open", path: "https://example.test" }, ":1")).toEqual({
      argv: ["env", "DISPLAY=:1", "xdg-open", "https://example.test"],
    });
  });

  const installed = (name: string) =>
    new RegExp(`^\\s+${name.replace(".", "\\.")}\\b`, "m").test(dockerfile);

  it("reads the image's package list", () => {
    expect(installed("xterm")).toBe(true);
  });

  it.each(LAUNCHERS)("installs no %s", (name) => {
    expect(installed(name)).toBe(false);
  });
});
