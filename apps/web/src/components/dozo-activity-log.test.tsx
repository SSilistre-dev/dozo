// @vitest-environment jsdom
import type { AuditEvent, AuditEventPage } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ events: vi.fn() }));

vi.mock("../lib/rpc", () => {
  const rpc = { audit: { events: api.events } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("@lingui/core/macro", () => ({
  msg: (strings: TemplateStringsArray) => ({ id: strings.join(""), message: strings.join("") }),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en-GB", _: (descriptor: { message: string }) => descriptor.message },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => (
    <button type="button" {...props} />
  ),
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  Spinner: (props: ComponentProps<"svg">) => <svg role="status" {...props} />,
}));

import { queryClient } from "../lib/query";
import { DozoActivityLogRow, dozoActivityAction } from "./dozo-activity-log";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  api.events.mockReset();
  queryClient.clear();
  vi.unstubAllGlobals();
});

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "evt-1",
    createdAt: "2026-11-19T10:00:00.000Z",
    organizationId: "org-1",
    spaceId: "space-1",
    spaceName: "Home",
    actorType: "bot",
    actorId: "bot-1",
    actorLabel: "Scout",
    action: "tool.call",
    targetType: "tool",
    targetId: "web_fetch",
    targetLabel: "Web fetch",
    outcome: "success",
    runId: "run-1",
    threadId: "chat-1",
    ip: "203.0.113.7",
    userAgent: "Agent/1.0",
    metadata: { secretish: "kept-out" },
    ...overrides,
  };
}

const page = (events: AuditEvent[], nextCursor: string | null = null): AuditEventPage => ({
  events,
  nextCursor,
});

async function render() {
  await act(async () => {
    root.render(<DozoActivityLogRow />);
  });
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === name);
const details = (index: number) =>
  [...(rows()[index]?.querySelectorAll(":scope > p span") ?? [])].map((span) => span.textContent);
const rows = () => [...container.querySelectorAll('[data-testid="dozo-activity-row"]')];

async function opened() {
  await render();
  await vi.waitFor(() => expect(button("View")).toBeTruthy());
  await act(async () => button("View")?.click());
}

it("offers nothing to someone the server does not let read the log", async () => {
  api.events.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
  await render();
  await vi.waitFor(() => expect(api.events).toHaveBeenCalled());
  await act(async () => {});
  expect(container.textContent).toBe("");
});

it("lists the newest page first and shows no address, user agent or details", async () => {
  api.events.mockResolvedValue(
    page([
      event(),
      event({
        id: "evt-2",
        actorType: "user",
        actorLabel: "owner@example.com",
        spaceName: null,
        action: "auth.sign_in",
        targetLabel: null,
      }),
    ]),
  );
  await opened();
  expect(api.events).toHaveBeenCalledWith({ cursor: undefined, limit: 30 }, expect.anything());
  expect(rows().map((row) => row.querySelector("p")?.textContent)).toEqual([
    "Used a tool Web fetch",
    "Signed in",
  ]);
  expect(details(0)).toEqual(["Scout", "Home"]);
  expect(rows()[1]?.textContent).toContain("owner@example.com");
  expect(container.textContent).not.toContain("203.0.113");
  expect(container.textContent).not.toContain("Agent/1.0");
  expect(container.textContent).not.toContain("kept-out");
  expect(rows()[0]?.querySelector("time")?.getAttribute("dateTime")).toBe(
    "2026-11-19T10:00:00.000Z",
  );
});

it("marks refused and failed actions", async () => {
  api.events.mockResolvedValue(
    page([
      event({ outcome: "denied" }),
      event({ id: "evt-2", outcome: "failure", actorLabel: null, spaceName: null }),
    ]),
  );
  await opened();
  expect(details(0)).toEqual(["Scout", "Home", "Denied"]);
  expect(details(1)).toEqual(["Failed"]);
});

it("loads older pages from the server's cursor", async () => {
  api.events
    .mockResolvedValueOnce(page([event()], "evt-1"))
    .mockResolvedValueOnce(page([event({ id: "evt-0", action: "space.renamed" })]));
  await opened();
  await act(async () => button("Load older")?.click());
  await vi.waitFor(() => expect(rows()).toHaveLength(2));
  expect(api.events).toHaveBeenLastCalledWith({ cursor: "evt-1", limit: 30 }, expect.anything());
  expect(rows()[1]?.textContent).toContain("Changed a space");
  expect(button("Load older")).toBeUndefined();
});

it("says when an older page could not be read", async () => {
  api.events
    .mockResolvedValueOnce(page([event()], "evt-1"))
    .mockRejectedValueOnce(Object.assign(new Error("Bad request"), { status: 400 }));
  await opened();
  await act(async () => button("Load older")?.click());
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).toBeTruthy());
  expect(rows()).toHaveLength(1);
});

it("leaves out what an event lacks, and says when there is nothing", async () => {
  api.events.mockResolvedValue(
    page([event({ actorLabel: null, spaceName: null, targetLabel: null })]),
  );
  await opened();
  expect(rows()[0]?.querySelectorAll("p")).toHaveLength(1);
  act(() => root.unmount());
  root = createRoot(container);
  queryClient.clear();
  api.events.mockResolvedValue(page([]));
  await opened();
  expect(container.textContent).toContain("No activity yet");
});

it("names every documented action in words, and shows an unknown one by its name", async () => {
  const actions = [
    "tool.call",
    "credential.used",
    "credential.created",
    "credential.changed",
    "credential.deleted",
    "credential.revealed",
    "approval.decided",
    "approval.auto_reviewed",
    "approval.policy.changed",
    "auth.sign_in",
    "auth.sign_out",
    "auth.password.changed",
    "auth.session.revoked",
    "audit_log.exported",
    "auth.passkey.added",
    "device.paired",
    "space.created",
  ];
  const labels = actions.map((action) => dozoActivityAction(action)?.message);
  expect(labels.every((label) => label && !label.includes("."))).toBe(true);
  expect(dozoActivityAction("plan.granted")).toBeNull();
  api.events.mockResolvedValue(page([event({ action: "plan.granted", targetLabel: null })]));
  await opened();
  expect(rows()[0]?.querySelector("p")?.textContent).toBe("plan.granted");
});
