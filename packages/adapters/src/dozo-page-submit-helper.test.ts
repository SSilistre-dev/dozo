import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// The page-side check of the bot's computer (a rule of dozo/brand/brand.json on its page browser):
// which click presses a control that submits a form that is not a search. The script is read from the
// branded tree and run on a page as the computer runs it, in a DOM without layout.
const source = readFileSync(
  new URL("../../../infra/sandboxes/computer/rakazo-page-browser", import.meta.url),
  "utf8",
);
const helpers = /^PURCHASE_HELPERS = r"""\n([\s\S]*?)"""/m.exec(source)?.[1] ?? "";

function judge(html: string, target = "#t", at = [10, 10]) {
  const dom = new JSDOM(`<body>${html}</body>`, { runScripts: "outside-only" });
  const { window } = dom;
  window.eval(helpers);
  const hit = window.document.querySelector(target);
  window.document.elementFromPoint = () => hit;
  const check = window as unknown as {
    __rakazoPurchase: { submitAt(x: number, y: number): Record<string, unknown> };
  };
  return check.__rakazoPurchase.submitAt(at[0]!, at[1]!);
}

describe("the page browser's check of a click as a form submit", () => {
  it.each([
    [
      "a button with no type in a form read with POST",
      "<form method=post><button id=t>Send</button></form>",
      true,
    ],
    ["a submit input", "<form method=post><input id=t type=submit></form>", true],
    ["an image input", "<form method=post><input id=t type=image></form>", true],
    ["a form read with GET that is not a search", "<form><button id=t>Join</button></form>", true],
    [
      "a button that posts a GET form",
      "<form><button id=t formmethod=post>Post</button></form>",
      true,
    ],
    [
      "a button named to a form by its attribute",
      "<form id=f method=post></form><button id=t form=f>Send</button>",
      true,
    ],
    [
      "the text inside a button",
      "<form method=post><button><b id=t>Send</b></button></form>",
      true,
    ],
    ["a search form told by its role", "<form role=search><button id=t>Go</button></form>", false],
    [
      "a search form told by its field",
      "<form><input type=search><button id=t>Go</button></form>",
      false,
    ],
    [
      "a form inside a search landmark",
      "<div role=search><form><button id=t>Go</button></form></div>",
      false,
    ],
    [
      "a search form that posts",
      "<form role=search method=post><button id=t>Go</button></form>",
      true,
    ],
    [
      "a button that is not a submit",
      "<form method=post><button id=t type=button>Menu</button></form>",
      false,
    ],
    ["a button outside any form", "<button id=t>Outside</button>", false],
    ["a link", '<form method=post><a id=t href="/docs">Docs</a></form>', false],
    ["a script's button", "<form method=post><div id=t role=button>Like</div></form>", false],
    ["a disabled button", "<form method=post><button id=t disabled>Wait</button></form>", false],
    [
      "a form that closes a dialog",
      "<form method=dialog><button id=t>Close</button></form>",
      false,
    ],
    [
      "a button that closes a dialog",
      "<form method=post><button id=t formmethod=dialog>Close</button></form>",
      false,
    ],
    ["a field", "<form method=post><input id=t type=text></form>", false],
    ["nothing", "<p>text</p>", false],
  ])("%s", (_what, html, submit) => {
    expect(judge(html)).toEqual({ submit });
  });

  it("says when the spot is outside the view, or inside a frame", () => {
    expect(judge("<button id=t>x</button>", "#t", [-1, 5])).toEqual({ offscreen: true });
    expect(judge("<iframe id=t></iframe>")).toEqual({ inFrame: true });
  });
});
