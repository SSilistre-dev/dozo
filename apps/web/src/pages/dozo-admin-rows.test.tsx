// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Row, Rows } from "./dozo-admin-rows";

// jsdom has no layout: this holds the classes the layout rests on. The longest row (suspended,
// a granted plan, every action) was checked in a browser at 1280 and 390 pixels wide.

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

const email = "deniz.uzun-bir-adres@example.com";

function longest(withActions = true) {
  act(() =>
    root.render(
      <Rows testId="rows">
        <Row
          label={email}
          title={<a href="/admin/users/u3">{email}</a>}
          details={
            <>
              <span>Deniz</span>
              <span>Joined 14 Nov 2026</span>
              <span>Last seen 14 Nov 2026</span>
              <span>0 bots</span>
            </>
          }
        >
          {withActions
            ? [
                "Premium Plus",
                "Granted",
                "3 days left",
                "Then Free",
                "Set plan",
                "Suspended",
                "Restore",
                "Ban",
                "Delete",
              ].map((text) => (
                <button key={text} type="button">
                  {text}
                </button>
              ))
            : null}
        </Row>
      </Rows>,
    ),
  );
  return host.querySelector("li") as HTMLLIElement;
}

it("keeps the identity at least 16rem wide and wraps the actions, never squeezing the email", () => {
  const row = longest();
  expect(row.className).toContain("flex-wrap");
  const identity = row.querySelector("[data-row-identity]") as HTMLElement;
  expect(identity.className.split(" ")).toEqual(
    expect.arrayContaining(["basis-64", "flex-1", "min-w-0", "max-w-full"]),
  );
  const actions = row.querySelector("[data-row-actions]") as HTMLElement;
  expect(actions.className.split(" ")).toEqual(expect.arrayContaining(["flex-wrap", "ml-auto"]));
  expect(actions.querySelectorAll("button")).toHaveLength(9);
  expect(identity.contains(actions)).toBe(false);
});

it("keeps a cut email readable on hover, and leaves no empty action block", () => {
  const row = longest(false);
  expect(row.querySelector("[title]")?.getAttribute("title")).toBe(email);
  expect(row.querySelector("[data-row-actions]")).toBeNull();
});
