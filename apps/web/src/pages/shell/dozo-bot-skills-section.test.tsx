// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BillingStatus, Bot, ComputerStatus } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { act, createContext, useContext, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  billing: null as Partial<BillingStatus> | null,
  me: vi.fn(),
  list: vi.fn(),
  boot: vi.fn(),
  start: vi.fn(),
}));

vi.mock("../../lib/rpc", () => {
  const client = {
    me: api.me,
    skills: { list: api.list, start: api.start },
    computer: { boot: api.boot },
  };
  return {
    rpc: client,
    createSpaceRpc: () => client,
    rpcForSpace: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("../../components/SubscriptionGate", () => ({
  useBilling: () => ({ status: api.billing }),
}));
vi.mock("./computer-panel", () => ({ ComputerPanel: () => null }));
// Its own test covers it; here only where it sits.
vi.mock("./dozo-saved-values-review", () => ({
  SavedValuesReview: ({ skill }: { skill: { id: string } }) => (
    <span data-testid="review" data-skill={skill.id} />
  ),
}));
vi.mock("./bot-settings-sections", () => ({
  PanelSection: ({
    label,
    action,
    children,
  }: {
    label: ReactNode;
    action?: ReactNode;
    children?: ReactNode;
  }) => (
    <section>
      <h3>{label}</h3>
      {action}
      {children}
    </section>
  ),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@rakazo/ui-web", () => {
  const Open = createContext<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    trigger?: RefObject<HTMLButtonElement | null>;
  }>({
    open: false,
    onOpenChange: () => undefined,
  });
  // As Base UI does: closing returns focus to the trigger unless `finalFocus` says no.
  const Content = ({
    children,
    finalFocus,
  }: {
    children: ReactNode;
    finalFocus?: () => boolean;
  }) => {
    const { trigger } = useContext(Open);
    useEffect(
      () => () => {
        if (finalFocus?.() !== false) trigger?.current?.focus();
      },
      [],
    );
    return <div data-testid="popover">{children}</div>;
  };
  return {
    Button: (props: ComponentProps<"button"> & { variant?: string; size?: string }) => {
      const { variant: _variant, size: _size, ...rest } = props;
      return <button type="button" {...rest} />;
    },
    Label: ({ htmlFor, children }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Popover: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => {
      const trigger = useRef<HTMLButtonElement>(null);
      return <Open.Provider value={{ open, onOpenChange, trigger }}>{children}</Open.Provider>;
    },
    PopoverTrigger: ({
      children,
      "data-testid": testId,
    }: {
      children: ReactNode;
      "data-testid"?: string;
    }) => {
      const { open, onOpenChange, trigger } = useContext(Open);
      return (
        <button
          ref={trigger}
          type="button"
          data-testid={testId}
          onClick={() => onOpenChange(!open)}
        >
          {children}
        </button>
      );
    },
    PopoverContent: ({
      children,
      finalFocus,
    }: {
      children: ReactNode;
      finalFocus?: () => boolean;
    }) => (useContext(Open).open ? <Content finalFocus={finalFocus}>{children}</Content> : null),
  };
});

import { ComputerPanel } from "./computer-panel";
import { DozoBotSkillsSection } from "./dozo-bot-skills-section";

const bot = { id: "bot-1", name: "Ada" } as Bot;
const skill = (id: string, status: string, name: string) => ({
  id,
  status,
  name,
  goal: `goal ${id}`,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onOpen: ReturnType<typeof vi.fn>;

function computerPanel(computer: Partial<ComputerStatus> | null = null) {
  return (
    <ComputerPanel
      {...({ bot, computer, onOpen } as unknown as ComponentProps<typeof ComputerPanel>)}
    />
  );
}

/** Renders, then waits for the plan and, once the section shows, its list, unless told not to. */
async function render(computer: ReactNode = computerPanel(), settle = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DozoBotSkillsSection bot={bot} computer={computer} />
      </QueryClientProvider>,
    ),
  );
  if (!settle) return;
  const settled = async () => {
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    await act(flush);
  };
  await settled();
  await settled();
}

const byText = (text: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === text);

async function click(node: Element | null | undefined) {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
}

async function type(input: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.billing = null;
  api.me.mockReset();
  api.me.mockResolvedValue({ billingEnabled: false });
  api.list.mockReset();
  api.boot.mockReset();
  api.start.mockReset();
  api.list.mockResolvedValue([
    skill("s1", "saved", "Weekly export"),
    skill("s2", "draft", "Half done"),
    skill("s3", "saved", ""),
  ]);
  api.boot.mockResolvedValue({});
  api.start.mockResolvedValue(skill("s4", "recording", ""));
  onOpen = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("lists the bot's saved skills by name under Skills", async () => {
  await render();
  await vi.waitFor(() => expect(container.querySelectorAll("li")).toHaveLength(2));
  expect(api.list).toHaveBeenCalledWith({ botId: "bot-1" }, expect.anything());
  expect(container.querySelector("h3")?.textContent).toBe("Skills");
  expect([...container.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "Weekly export",
    "goal s3",
  ]);
  // Each saved skill gets its review marker beside its name, which shows only when needed.
  expect(
    [...container.querySelectorAll('[data-testid="review"]')].map((node) =>
      node.getAttribute("data-skill"),
    ),
  ).toEqual(["s1", "s3"]);
});

it("shows no list when nothing is saved", async () => {
  api.list.mockResolvedValue([]);
  await render();
  expect(container.querySelector("ul")).toBeNull();
  expect(byText("Teach a task")).toBeDefined();
});

it("is not shown on a plan with no computer", async () => {
  api.me.mockResolvedValue({ billingEnabled: true });
  api.billing = { state: "active", funding: "byok", byokTier: "standard" };
  await render();
  expect(container.innerHTML).toBe("");
});

it("is shown only once the plan is known: never while it loads or after a failed lookup", async () => {
  const me = deferred<{ billingEnabled: boolean }>();
  api.me.mockReturnValueOnce(me.promise);
  await render(computerPanel(), false);
  await vi.waitFor(() => expect(api.me).toHaveBeenCalled());
  expect(container.innerHTML).toBe("");
  await act(async () => me.resolve({ billingEnabled: false }));
  act(() => root.unmount());
  root = createRoot(container);
  // A billed deployment with no status: the lookup failed, so the plan is not known.
  api.me.mockResolvedValue({ billingEnabled: true });
  await render();
  expect(api.me).toHaveBeenCalledTimes(2);
  expect(container.innerHTML).toBe("");
  api.billing = { state: "active", funding: "byok", byokTier: "pro" };
  await render();
  expect(byText("Teach a task")).toBeDefined();
});

it("is shown on a trial or a credit plan", async () => {
  api.billing = { state: "trialing", funding: "byok", byokTier: "standard" };
  await render();
  expect(byText("Teach a task")).toBeDefined();
  api.billing = { state: "active", funding: "credits", byokTier: "standard" };
  await render();
  expect(byText("Teach a task")).toBeDefined();
});

it("is not shown for a computer on the person's own machine, or without a computer section", async () => {
  await render(computerPanel({ kind: "desktop", runsOnUserMachine: true }));
  expect(container.innerHTML).toBe("");
  await render(null);
  expect(container.innerHTML).toBe("");
  await render(<div />);
  expect(container.innerHTML).toBe("");
});

it("starts teaching from the goal and opens the bot's computer", async () => {
  const started = deferred<unknown>();
  api.start.mockReturnValueOnce(started.promise);
  await render();
  await click(container.querySelector('[data-testid="dozo-teach-start"]'));
  const goal = container.querySelector("textarea") as HTMLTextAreaElement;
  expect(goal.placeholder).toContain("Export this week's list");
  expect(byText("Start recording")?.hasAttribute("disabled")).toBe(true);
  await type(goal, "  Export the list  ");
  await click(byText("Start recording"));
  expect(byText("Starting…")?.hasAttribute("disabled")).toBe(true);
  await vi.waitFor(() =>
    expect(api.start).toHaveBeenCalledWith({ botId: "bot-1", goal: "Export the list" }),
  );
  expect(api.boot).toHaveBeenCalledWith({ botId: "bot-1" });
  expect(onOpen).not.toHaveBeenCalled();
  await act(async () => started.resolve(skill("s4", "recording", "")));
  await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
  expect(container.querySelector('[data-testid="popover"]')).toBeNull();
  // Keys typed into a button never reach the recording, so focus does not go back to it.
  const trigger = container.querySelector('[data-testid="dozo-teach-start"]');
  expect(document.activeElement).not.toBe(trigger);
  expect(document.activeElement).toBe(document.body);

  // Cancel returns focus to the trigger, as any popover does.
  await click(trigger);
  await click(byText("Cancel"));
  expect(document.activeElement).toBe(trigger);
});

it("shows why it could not start, and forgets it on Cancel", async () => {
  api.start.mockRejectedValue(new Error("A teaching session is already active"));
  await render();
  await click(container.querySelector('[data-testid="dozo-teach-start"]'));
  await type(container.querySelector("textarea") as HTMLTextAreaElement, "Export");
  await click(byText("Start recording"));
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  expect(onOpen).not.toHaveBeenCalled();
  await click(byText("Cancel"));
  expect(container.querySelector('[data-testid="popover"]')).toBeNull();
  await click(container.querySelector('[data-testid="dozo-teach-start"]'));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  // The trigger closes it too.
  await click(container.querySelector('[data-testid="dozo-teach-start"]'));
  expect(container.querySelector('[data-testid="popover"]')).toBeNull();
});

it("treats a start whose answer was lost as started when the bot is recording", async () => {
  api.start.mockRejectedValue(new TypeError("Failed to fetch"));
  await render();
  api.list.mockResolvedValue([skill("s1", "saved", "Weekly export"), skill("s4", "recording", "")]);
  await click(container.querySelector('[data-testid="dozo-teach-start"]'));
  await type(container.querySelector("textarea") as HTMLTextAreaElement, "Export");
  await click(byText("Start recording"));
  await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
  expect(api.list).toHaveBeenLastCalledWith({ botId: "bot-1" });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[data-testid="popover"]')).toBeNull();
  expect(document.activeElement).toBe(document.body);
});

it("shows the start's error when the bot is not recording or the re-read fails", async () => {
  api.start.mockRejectedValue(new Error("A teaching session is already active"));
  await render();
  const calls = api.list.mock.calls.length;
  await click(container.querySelector('[data-testid="dozo-teach-start"]'));
  await type(container.querySelector("textarea") as HTMLTextAreaElement, "Export");
  await click(byText("Start recording"));
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "A teaching session is already active",
  );
  expect(api.list.mock.calls.length).toBe(calls + 1);
  expect(onOpen).not.toHaveBeenCalled();

  await click(byText("Cancel"));
  api.list.mockRejectedValue(new TypeError("Failed to fetch"));
  await click(container.querySelector('[data-testid="dozo-teach-start"]'));
  await type(container.querySelector("textarea") as HTMLTextAreaElement, "Export");
  await click(byText("Start recording"));
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "A teaching session is already active",
    ),
  );
  expect(onOpen).not.toHaveBeenCalled();
});

it("gets the computer section as the shell builds it: a ComputerPanel that opens the computer", () => {
  // The section reads `onOpen` from the panel's computer element, so a change to how the shell
  // passes it would hide the section without an error. The tree under test is the branded one.
  const read = (file: string) => readFileSync(join(import.meta.dirname, file), "utf8");
  const shell = read("../Shell.tsx");
  expect(shell).toContain('import { ComputerPanel } from "./shell/computer-panel";');
  const built = shell.slice(shell.indexOf("computerPanel={"));
  expect(built).toMatch(/^computerPanel=\{\s*active \? \(\s*<ComputerPanel\b/);
  expect(built.slice(0, built.indexOf(") : null"))).toMatch(/\n\s*onOpen=\{/);
  const side = read("side-panel.tsx");
  const settings = side.slice(side.indexOf("<BotSettings"));
  expect(settings.slice(0, settings.indexOf("routines="))).toContain("computer={computerPanel}");
  expect(read("bot-panel.tsx")).toContain("<DozoBotSkillsSection bot={bot} computer={computer} />");
});
