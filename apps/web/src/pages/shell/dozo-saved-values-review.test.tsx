// @vitest-environment jsdom

import type { SkillPlaybook, TaughtSkill } from "@rakazo/contracts";
import { TEACH_NAME_TAKEN } from "@rakazo/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act, createContext, useContext } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ decideSaved: vi.fn(), list: vi.fn(async () => []) }));

vi.mock("../../lib/rpc", () => {
  const client = { dozoTeach: { decideSaved: api.decideSaved }, skills: { list: api.list } };
  return {
    rpc: client,
    createSpaceRpc: () => client,
    rpcForSpace: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: parts }, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@rakazo/ui-web", () => {
  const Group = createContext<{ value: string[]; onValueChange: (value: string[]) => void }>({
    value: [],
    onValueChange: () => undefined,
  });
  const Open = createContext<{ open: boolean; onOpenChange: (open: boolean) => void }>({
    open: false,
    onOpenChange: () => undefined,
  });
  return {
    Button: (props: ComponentProps<"button"> & { variant?: string; size?: string }) => {
      const { variant: _variant, size: _size, ...rest } = props;
      return <button type="button" {...rest} />;
    },
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    ToggleGroup: ({
      value,
      onValueChange,
      children,
    }: {
      value: string[];
      onValueChange: (value: string[]) => void;
      children: ReactNode;
    }) => <Group.Provider value={{ value, onValueChange }}>{children}</Group.Provider>,
    ToggleGroupItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const group = useContext(Group);
      return (
        <button
          type="button"
          aria-pressed={group.value.includes(value)}
          onClick={() => group.onValueChange(group.value.includes(value) ? [] : [value])}
        >
          {children}
        </button>
      );
    },
    Popover: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => <Open.Provider value={{ open, onOpenChange }}>{children}</Open.Provider>,
    PopoverTrigger: ({ children, ...rest }: { children: ReactNode; "data-testid"?: string }) => {
      const { open, onOpenChange } = useContext(Open);
      return (
        <button type="button" data-testid={rest["data-testid"]} onClick={() => onOpenChange(!open)}>
          {children}
        </button>
      );
    },
    PopoverContent: ({ children }: { children: ReactNode }) =>
      useContext(Open).open ? <div data-testid="popover">{children}</div> : null,
  };
});

import { SavedValuesReview } from "./dozo-saved-values-review";

const playbook: SkillPlaybook = {
  whenToUse: "",
  inputs: ["Sign in"],
  steps: ['Type "ali@example.test".', "Press key: Tab.", "Paste or type: hunter2."],
  howToCheck: "",
  whatToReturn: "",
  approvalBoundaries: "",
  failureHandling: "",
};
const skill = (steps = playbook.steps) =>
  ({ id: "skill-1", status: "saved", playbook: { ...playbook, steps } }) as TaughtSkill;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function render(shown: TaughtSkill = skill()) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SavedValuesReview skill={shown} />
      </QueryClientProvider>,
    ),
  );
}

const marker = () => container.querySelector('[data-testid="dozo-saved-values-review"]');
const rows = () => [...container.querySelectorAll('[data-testid="skill-draft-value"]')];
const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find((node) => node.textContent === text);

async function click(node: Element | null | undefined) {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.decideSaved.mockReset();
  api.decideSaved.mockResolvedValue(skill(["Type {{email}}."]));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows nothing for a skill whose steps type no text verbatim", async () => {
  await render(skill(["Type {{email}}.", 'Type the text "kept".']));
  expect(container.innerHTML).toBe("");
});

it("marks a skill with text in its steps and opens each value with the draft's choices", async () => {
  await render();
  expect(marker()?.textContent).toBe("Review");
  expect(rows()).toHaveLength(0);
  await click(marker());
  expect(rows().map((row) => row.querySelector("span")?.textContent)).toEqual([
    "ali@example.test",
    "hunter2",
  ]);
  expect(
    rows().map((row) => (row.querySelector("input") as HTMLInputElement | null)?.value),
  ).toEqual(["value_1", "value_2"]);
  // Fixed says who sees it, as on the draft card.
  await click(button(rows()[0]!, "Fixed"));
  expect(rows()[0]?.textContent).toContain("visible to everyone in this space");
  await click(button(rows()[1]!, "Hidden"));
  await click(button(container, "Save"));
  expect(api.decideSaved).toHaveBeenCalledWith({
    skillId: "skill-1",
    steps: playbook.steps,
    decisions: {
      "{{value 1}}": { action: "fixed" },
      "{{value 2}}": { action: "hidden", name: "value_2" },
    },
  });
  // Saved: the popover closes and the list is read again.
  await vi.waitFor(() => expect(rows()).toHaveLength(0));
});

it("says a name is taken, shows other failures, and Cancel closes", async () => {
  await render();
  await click(marker());
  api.decideSaved.mockRejectedValueOnce(Object.assign(new Error("x"), { code: TEACH_NAME_TAKEN }));
  await click(button(container, "Save"));
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Each name can be used once.",
    ),
  );
  api.decideSaved.mockRejectedValueOnce(new Error("down"));
  await click(button(container, "Save"));
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).not.toBe(
      "Each name can be used once.",
    ),
  );
  await click(button(container, "Cancel"));
  expect(rows()).toHaveLength(0);
  // Opening again starts without the old failure.
  await click(marker());
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
