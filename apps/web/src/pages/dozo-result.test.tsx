// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings.join(""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./dozo-email-link", () => ({
  LinkResult: ({
    title,
    detail,
    children,
  }: {
    title: ReactNode;
    detail?: string | null;
    children: ReactNode;
  }) => (
    <section>
      <h1>{title}</h1>
      {detail ? <p>{detail}</p> : null}
      {children}
    </section>
  ),
  OnwardLink: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

import { CallbackResult, McpOAuthResult, PageUnavailable, SlackInstallFailed } from "./dozo-result";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const show = (node: ReactNode) => act(() => root.render(node));
const link = () => container.querySelector("a");

it("a callback page says it may be closed and offers one way back", () => {
  show(<CallbackResult />);
  expect(container.querySelector("h1")?.textContent).toBe("You can close this window.");
  expect(container.querySelectorAll("a")).toHaveLength(1);
  expect(link()?.getAttribute("href")).toBe("/");
});

it("the OAuth page gives the provider's reason under the failure heading", () => {
  show(<McpOAuthResult error="access_denied" done={false} />);
  expect(container.querySelector("h1")?.textContent).toBe("OAuth connection failed");
  expect(container.querySelector("p")?.textContent).toBe("access_denied");
  expect(link()?.getAttribute("href")).toBe("/app");
});

it("the OAuth page names its other two states without a reason line", () => {
  show(<McpOAuthResult error={null} done />);
  expect(container.querySelector("h1")?.textContent).toBe("Connected");
  expect(container.querySelector("p")).toBeNull();
  show(<McpOAuthResult error={null} done={false} />);
  expect(container.querySelector("h1")?.textContent).toBe("Finishing MCP connection…");
});

it("a failed Slack install returns to the messaging settings", () => {
  show(<SlackInstallFailed />);
  expect(container.querySelector("h1")?.textContent).toBe("Could not connect");
  expect(link()?.getAttribute("href")).toBe("/app?settings=messaging");
});

it("an unavailable shared page says why and opens the app", () => {
  show(<PageUnavailable />);
  expect(container.querySelector("h1")?.textContent).toBe("This page isn't available");
  expect(container.querySelector("p")?.textContent).toBe(
    "The owner may have turned off its link or deleted it.",
  );
  expect(link()?.getAttribute("href")).toBe("/");
});
