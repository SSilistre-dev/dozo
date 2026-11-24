// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The approval card's Allow for this run (dozo/brand/brand.json, AskCard.tsx). Runs on the staged tree.

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useLinkFavicon: () => ({ icon: null, unusable: () => undefined }),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {},
  rpcForSpace: () => ({}),
  createSpaceRpc: () => ({}),
  selectedSpaceId: () => null,
}));
vi.mock("./vault/use-vault-contacts", () => ({ useVaultContacts: () => [] }));

import type { AskBlock } from "./AskCard";
import { AskCard } from "./AskCard";
import { dozoRunAllowLabel } from "./dozo-ask-label";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const card: AskBlock = {
  kind: "ask",
  approvalEffectId: "effect-1",
  text: "Review before computer_act",
  status: "pending",
  actions: [
    { id: "allow", label: "Allow once" },
    { id: "allow_run", label: "Allow for this run" },
    { id: "always", label: "Always allow this tool" },
    { id: "deny", label: "Deny" },
  ],
};

async function render(block: AskBlock, onAnswer: (text: string) => Promise<void>) {
  await act(async () =>
    root.render(
      <AskCard
        block={block}
        canAnswer
        canDismiss={false}
        onAnswer={onAnswer}
        onDismiss={async () => undefined}
      />,
    ),
  );
}

it("offers Allow for this run as an approval answer and sends its id", async () => {
  const onAnswer = vi.fn(async () => undefined);
  await render(card, onAnswer);
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.map((item) => item.textContent)).toEqual([
    "Allow once",
    "Allow for this run",
    "Always allow this tool",
    "Deny",
  ]);
  await act(async () => buttons[1]!.click());
  expect(onAnswer).toHaveBeenCalledWith("allow_run");
});

it("shows an answered card as its button said it", async () => {
  await render({ ...card, status: "answered", answer: "allow_run" }, async () => undefined);
  expect(container.textContent).toContain("Allow for this run");
  expect(container.textContent).not.toContain("allow_run");
});

it("names only that answer", () => {
  expect(dozoRunAllowLabel("allow_run")).toBe("Allow for this run");
  expect(dozoRunAllowLabel("allow")).toBeUndefined();
});
