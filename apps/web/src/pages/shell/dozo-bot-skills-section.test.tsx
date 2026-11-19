// @vitest-environment jsdom

import type { BillingStatus, Bot, ComputerStatus } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act, createContext, useContext } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  billing: null as Partial<BillingStatus> | null,
  list: vi.fn(),
  boot: vi.fn(),
  start: vi.fn(),
}));

vi.mock("../../lib/rpc", () => {
  const client = {
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
  const Open = createContext<{ open: boolean; onOpenChange: (open: boolean) => void }>({
    open: false,
    onOpenChange: () => undefined,
  });
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
    }) => <Open.Provider value={{ open, onOpenChange }}>{children}</Open.Provider>,
    PopoverTrigger: ({
      children,
      "data-testid": testId,
    }: {
      children: ReactNode;
      "data-testid"?: string;
    }) => {
      const { open, onOpenChange } = useContext(Open);
      return (
        <button type="button" data-testid={testId} onClick={() => onOpenChange(!open)}>
          {children}
        </button>
      );
    },
    PopoverContent: ({ children }: { children: ReactNode }) =>
      useContext(Open).open ? <div data-testid="popover">{children}</div> : null,
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

async function render(computer: ReactNode = computerPanel()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DozoBotSkillsSection bot={bot} computer={computer} />
      </QueryClientProvider>,
    ),
  );
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
});

it("shows no list when nothing is saved", async () => {
  api.list.mockResolvedValue([]);
  await render();
  expect(container.querySelector("ul")).toBeNull();
  expect(byText("Teach a task")).toBeDefined();
});

it("is not shown on a plan with no computer", async () => {
  api.billing = { state: "active", funding: "byok", byokTier: "standard" };
  await render();
  expect(container.innerHTML).toBe("");
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
