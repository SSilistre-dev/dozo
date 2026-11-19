// @vitest-environment jsdom

import type { DozoTeachValue, SkillPlaybook } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act, createContext, useContext } from "react";
import { createRoot } from "react-dom/client";
import type { Mock } from "vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  review: vi.fn(),
  save: vi.fn(),
  test: vi.fn(),
  list: vi.fn(async () => []),
}));

vi.mock("../../lib/rpc", () => {
  const client = {
    dozoTeach: { review: api.review, save: api.save, test: api.test },
    skills: { list: api.list },
  };
  return {
    rpc: client,
    createSpaceRpc: () => client,
    rpcForSpace: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("../ai/primitives", () => ({
  BuiCard: (props: ComponentProps<"div">) => <div {...props} />,
}));
vi.mock("@rakazo/ui-web", () => {
  const Group = createContext<{ value: string[]; onValueChange: (value: string[]) => void }>({
    value: [],
    onValueChange: () => undefined,
  });
  return {
    Button: (props: ComponentProps<"button"> & { variant?: string }) => {
      const { variant: _variant, ...rest } = props;
      return <button type="button" {...rest} />;
    },
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Label: ({ htmlFor, children }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
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
  };
});

import { SkillDraftCard } from "./dozo-skill-draft-card";

const playbook: SkillPlaybook = {
  whenToUse: "",
  inputs: ["the account"],
  steps: ["Type {{value 1}}", "Type {{value 2}}", "Type {{value 3}}"],
  howToCheck: "",
  whatToReturn: "",
  approvalBoundaries: "",
  failureHandling: "",
};

const values: DozoTeachValue[] = [
  {
    placeholder: "{{value 1}}",
    text: "ali.veli.uzun.adres@subdomain.example.test",
    secret: false,
  },
  { placeholder: "{{value 2}}", text: "Weekly", secret: false, suggestion: { name: "report" } },
  // Protected input, and typing whose text could not be rebuilt.
  { placeholder: "{{value 3}}", text: null, secret: true },
  { placeholder: "{{value 4}}", text: null, secret: false },
];

function block(status: "draft" | "saved" = "draft") {
  return {
    kind: "skill_draft" as const,
    skillId: "skill-1",
    name: "Export",
    goal: "Export the list",
    playbook,
    status,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let onRefresh: Mock<() => Promise<void>>;
let onAddRoutine: Mock<(name: string, prompt: string) => void>;
let client: QueryClient;

async function render(status: "draft" | "saved" | ReturnType<typeof block> = "draft") {
  const shown = typeof status === "string" ? block(status) : status;
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SkillDraftCard block={shown} onRefresh={onRefresh} onAddRoutine={onAddRoutine} />
      </QueryClientProvider>,
    ),
  );
}

async function renderValues() {
  await render();
  await vi.waitFor(() => expect(rows()).toHaveLength(4));
}

const rows = () => [...container.querySelectorAll('[data-testid="skill-draft-value"]')];
const button = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll("button")].find((node) => node.textContent === text);
const errorLine = () => container.querySelector("p.text-destructive")?.textContent ?? null;

async function click(node: Element | undefined) {
  expect(node).toBeDefined();
  await act(async () => (node as HTMLElement).click());
}

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.list.mockResolvedValue([]);
  api.review.mockResolvedValue({ values });
  api.save.mockImplementation(async (input: { playbook: SkillPlaybook }) => ({
    playbook: { ...input.playbook, steps: ["Type {{email}}", "Type Weekly"] },
  }));
  api.test.mockResolvedValue({ runId: "run-1" });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onRefresh = vi.fn(async () => undefined);
  onAddRoutine = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows one row per typed value, masks those without text, and offers them no Fixed", async () => {
  await renderValues();
  expect(api.review).toHaveBeenCalledWith({ skillId: "skill-1" }, expect.anything());
  expect(rows()).toHaveLength(4);
  // A long value is shown whole, wrapping instead of cut off.
  const shown = rows()[0]?.querySelector("[dir='auto']");
  expect(shown?.textContent).toBe("ali.veli.uzun.adres@subdomain.example.test");
  expect(shown?.className).not.toContain("truncate");
  expect(rows()[2]?.textContent).toContain("••••••");
  expect(rows()[3]?.textContent).toContain("••••••");
  expect(container.querySelector("textarea[id$='-inputs']")).toBeNull();

  const [first, second, third, fourth] = rows();
  // No suggestion: an input named after its number.
  expect(button(first as Element, "Variable")?.getAttribute("aria-pressed")).toBe("true");
  expect((first as Element).querySelector("input")?.value).toBe("value_1");
  expect(first?.querySelector("input")?.getAttribute("aria-label")).toBe("Name");
  // A suggestion only names it: nothing is kept as typed unless the teacher picks it.
  expect(button(second as Element, "Variable")?.getAttribute("aria-pressed")).toBe("true");
  expect(button(second as Element, "Fixed")?.getAttribute("aria-pressed")).toBe("false");
  expect(second?.querySelector("input")?.value).toBe("report");
  // Protected input is hidden by default; neither it nor unknown text can be kept as typed.
  expect(button(third as Element, "Hidden")?.getAttribute("aria-pressed")).toBe("true");
  expect(button(fourth as Element, "Variable")?.getAttribute("aria-pressed")).toBe("true");
  for (const row of [third, fourth]) {
    expect(button(row as Element, "Fixed")).toBeUndefined();
    expect(button(row as Element, "Variable")).toBeDefined();
    expect(button(row as Element, "Hidden")).toBeDefined();
    expect(button(row as Element, "Remove")).toBeDefined();
  }
  expect(container.textContent).not.toContain("visible to everyone");
});

it("says under a Fixed value who sees it, and sends Hidden with its name", async () => {
  await renderValues();
  const [first, second] = rows();
  await click(button(second as Element, "Fixed"));
  expect(second?.querySelector("input")).toBeNull();
  expect(second?.textContent).toContain("Saved in the steps, visible to everyone in this space.");
  expect(first?.textContent).not.toContain("visible to everyone");
  await click(button(first as Element, "Hidden"));
  await type(first?.querySelector("input") as HTMLInputElement, "password");
  await click(button(second as Element, "Variable"));
  expect(container.textContent).not.toContain("visible to everyone");
  await click(button(second as Element, "Fixed"));
  await click(button(container, "Save"));
  expect(api.save).toHaveBeenCalledWith(
    expect.objectContaining({
      decisions: {
        "{{value 1}}": { action: "hidden", name: "password" },
        "{{value 2}}": { action: "fixed" },
        "{{value 3}}": { action: "hidden", name: "value_3" },
        "{{value 4}}": { action: "variable", name: "value_4" },
      },
    }),
  );
});

it("saves with each value's decision, then shows what the server saved", async () => {
  await renderValues();
  const [first, second, third, fourth] = rows();
  await type(first?.querySelector("input") as HTMLInputElement, " email ");
  await click(button(second as Element, "Variable"));
  await type(second?.querySelector("input") as HTMLInputElement, "  ");
  await click(button(third as Element, "Remove"));
  // Pressing the chosen one again keeps it chosen.
  await click(button(fourth as Element, "Variable"));
  // A routine would carry the placeholders until the values are decided and saved.
  expect(button(container, "Add to routine")?.hasAttribute("disabled")).toBe(true);
  await click(button(container, "Save"));

  expect(api.save).toHaveBeenCalledWith({
    skillId: "skill-1",
    name: "Export",
    playbook,
    decisions: {
      "{{value 1}}": { action: "variable", name: "email" },
      "{{value 2}}": { action: "variable", name: "value_2" },
      "{{value 3}}": { action: "remove" },
      "{{value 4}}": { action: "variable", name: "value_4" },
    },
  });
  await vi.waitFor(() => expect(button(container, "Saved")).toBeDefined());
  expect(rows()).toHaveLength(0);
  const steps = container.querySelector("textarea[id$='-steps']") as HTMLTextAreaElement;
  expect(steps.value).toBe("Type {{email}}\nType Weekly");
  expect(onRefresh).toHaveBeenCalled();
  expect(button(container, "Add to routine")?.hasAttribute("disabled")).toBe(false);

  // Once saved, nothing typed is left to decide about.
  await type(container.querySelector("input[id$='-name']") as HTMLInputElement, "Export 2");
  await click(button(container, "Save"));
  expect(api.save).toHaveBeenLastCalledWith(
    expect.objectContaining({ name: "Export 2", decisions: {} }),
  );
});

it("tests with the same decisions and keeps the rows", async () => {
  await renderValues();
  await click(button(rows()[1] as Element, "Remove"));
  await click(button(container, "Test"));
  expect(api.test).toHaveBeenCalledWith(
    expect.objectContaining({
      skillId: "skill-1",
      decisions: {
        "{{value 1}}": { action: "variable", name: "value_1" },
        "{{value 2}}": { action: "remove" },
        "{{value 3}}": { action: "hidden", name: "value_3" },
        "{{value 4}}": { action: "variable", name: "value_4" },
      },
    }),
  );
  await vi.waitFor(() => expect(onRefresh).toHaveBeenCalled());
  expect(rows()).toHaveLength(4);
});

it("offers neither Save nor Test until the values are known, nor when they could not be", async () => {
  const review = deferred<{ values: DozoTeachValue[] }>();
  api.review.mockReturnValueOnce(review.promise);
  await render();
  expect(button(container, "Save")?.hasAttribute("disabled")).toBe(true);
  expect(button(container, "Test")?.hasAttribute("disabled")).toBe(true);
  expect(button(container, "Add to routine")?.hasAttribute("disabled")).toBe(true);
  await act(async () => review.reject(new Error("down")));
  await vi.waitFor(() => expect(errorLine()).toBe("Could not load"));
  expect(button(container, "Save")?.hasAttribute("disabled")).toBe(true);
  expect(button(container, "Test")?.hasAttribute("disabled")).toBe(true);
  expect(container.textContent).not.toContain("ali.veli");

  // A new mount reads again.
  act(() => root.unmount());
  root = createRoot(container);
  await renderValues();
  expect(button(container, "Save")?.hasAttribute("disabled")).toBe(false);
  expect(errorLine()).toBeNull();
});

it("behaves as upstream's card when there are no values to decide about", async () => {
  api.review.mockResolvedValue({ values: [] });
  await render();
  await vi.waitFor(() => expect(api.review).toHaveBeenCalled());
  const inputs = container.querySelector("textarea[id$='-inputs']") as HTMLTextAreaElement;
  expect(inputs.value).toBe("the account");
  await type(inputs, "a\nb");
  await click(button(container, "Test"));
  expect(api.test).toHaveBeenCalledWith({
    skillId: "skill-1",
    name: "Export",
    playbook: { ...playbook, inputs: ["a", "b"] },
    decisions: {},
  });
  await click(button(container, "Add to routine"));
  expect(onAddRoutine).toHaveBeenCalledWith("Export", expect.stringContaining("Export"));
});

it("never asks for values of a saved skill and reports a failed save", async () => {
  api.save.mockRejectedValue(new Error("Skill could not be saved now"));
  onRefresh.mockRejectedValue(new Error("refresh failed"));
  await render("saved");
  expect(api.review).not.toHaveBeenCalled();
  expect(button(container, "Saved")).toBeDefined();
  await type(container.querySelector("textarea[id$='-when']") as HTMLTextAreaElement, "Weekly");
  for (const id of ["-steps", "-check", "-return", "-approval", "-failure"]) {
    await type(container.querySelector(`textarea[id$='${id}']`) as HTMLTextAreaElement, "x");
  }
  await click(button(container, "Save"));
  await vi.waitFor(() => expect(errorLine()).not.toBeNull());
  expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ decisions: {} }));

  // A test of a saved skill keeps it saved with what was sent; a failed refresh is not its error.
  await click(button(container, "Test"));
  await vi.waitFor(() => expect(button(container, "Saved")).toBeDefined());
});

it("follows a later update of the skill only where this card has not written or been edited", async () => {
  api.review.mockResolvedValue({ values: [] });
  await render();
  const steps = () => container.querySelector("textarea[id$='-steps']") as HTMLTextAreaElement;
  const name = () => container.querySelector("input[id$='-name']") as HTMLInputElement;

  // Saved elsewhere with the same fields: shown as saved.
  await render("saved");
  expect(button(container, "Saved")).toBeDefined();

  // Another skill in the same card: its own fields.
  const other = {
    ...block("draft"),
    skillId: "skill-2",
    name: "Import",
    playbook: { ...playbook, steps: ["Open"] },
  };
  await render(other);
  expect(name().value).toBe("Import");
  expect(steps().value).toBe("Open");

  // An edit is kept over a later update of the same skill.
  await type(name(), "Mine");
  await render({ ...other, status: "saved", name: "Theirs" });
  expect(name().value).toBe("Mine");
  expect(button(container, "Save")).toBeDefined();

  // Once this card has written, a late saved status keeps what it wrote.
  const third = { ...other, skillId: "skill-3" };
  await render(third);
  await type(name(), "Mine");
  await click(button(container, "Test"));
  await vi.waitFor(() => expect(onRefresh).toHaveBeenCalled());
  await render({ ...third, status: "saved", name: "Theirs" });
  expect(name().value).toBe("Mine");
  expect(button(container, "Save")).toBeDefined();

  // With no name, a routine is named after the skill.
  await type(name(), "");
  await click(button(container, "Add to routine"));
  expect(onAddRoutine).toHaveBeenLastCalledWith("Theirs", expect.any(String));
});
