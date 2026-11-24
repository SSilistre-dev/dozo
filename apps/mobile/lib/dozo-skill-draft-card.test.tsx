// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type AlertButton = { text: string; style?: string; onPress?: () => void };
type Save = {
  save: (input: undefined, send: unknown) => Promise<unknown>;
  stale?: unknown[];
  onSaved?: () => unknown;
  onFailed?: (error: Error) => unknown;
};
const api = vi.hoisted(() => ({
  review: { data: undefined as unknown, error: null as unknown },
  enabled: [] as boolean[],
  send: vi.fn(),
  alert: vi.fn(),
  saves: [] as Save[],
  /** Which save of the card (0 Save, 1 Delete) is under way. */
  pending: undefined as number | undefined,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.flatMap((part, index) => [part, values[index] ?? ""]).join(""),
  }),
}));
vi.mock("@rakazo/ui-tokens", () => ({ typeScale: { cardTitle: {}, body: {} } }));
vi.mock("react-native", () => ({
  Alert: { alert: api.alert },
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./native", () => ({
  useMobileTokens: () => ({ card: "card", foreground: "fg", mutedForeground: "muted" }),
}));
vi.mock("./user-error", () => ({
  errorText: (error: Error, fallback: string) => error.message || fallback,
}));
vi.mock("./query", () => ({
  queryClient: "client",
  rpcQuery: (proc: string, input?: unknown) => ({ queryKey: [proc, input] }),
  useSave: (options: Save) => {
    const index = api.saves.length % 2;
    api.saves.push(options);
    return {
      pending: api.pending === index,
      run: () =>
        options.save(undefined, api.send).then(
          () => options.onSaved?.(),
          (error: Error) => options.onFailed?.(error),
        ),
    };
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (read: { enabled?: boolean }, client: unknown) => {
    expect(client).toBe("client");
    api.enabled.push(read.enabled ?? true);
    return read.enabled ? api.review : { data: undefined, error: null };
  },
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: (props: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
  }) => (
    <button type="button" disabled={props.disabled} data-busy={props.busy} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));

import { DozoSkillDraftCard } from "../components/thread/dozo-skill-draft-card";

const playbook = {
  whenToUse: "When the owner asks for the weekly sales report.",
  inputs: ["The week"],
  steps: ["Open the sales sheet.", "Sum each region in three lines."],
  howToCheck: "",
  whatToReturn: "The lines.",
  approvalBoundaries: "",
  failureHandling: "",
};
const draft = {
  kind: "skill_draft" as const,
  skillId: "skill-1",
  name: "Weekly report",
  goal: playbook.whenToUse,
  playbook,
  status: "draft" as const,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
async function render(block: typeof draft | (Omit<typeof draft, "status"> & { status: "saved" })) {
  await act(async () => root.render(<DozoSkillDraftCard block={block} />));
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === label);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.review = { data: { values: [], targets: [] }, error: null };
  api.enabled = [];
  api.saves = [];
  api.pending = undefined;
  api.send.mockReset();
  api.alert.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DozoSkillDraftCard", () => {
  it("shows the skill's name, when it is used and its steps, with Save and Delete", async () => {
    await render(draft);
    expect([...container.querySelectorAll("p")].map((line) => line.textContent)).toEqual([
      "Weekly report",
      playbook.whenToUse,
      "1. Open the sales sheet.",
      "2. Sum each region in three lines.",
    ]);
    expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
      "Save",
      "Delete",
    ]);
  });

  it("saves the draft as it is shown and reads it again", async () => {
    api.send.mockResolvedValue({});
    await render(draft);
    await act(async () => button("Save")!.click());
    expect(api.send).toHaveBeenCalledExactlyOnceWith("dozoTeach/save", {
      skillId: "skill-1",
      name: "Weekly report",
      playbook,
    });
    expect(api.saves[0]?.stale).toEqual([["dozoTeach/review", { skillId: "skill-1" }]]);
  });

  it("deletes only after the native confirmation, and is gone once deleted", async () => {
    api.send.mockResolvedValue({ ok: true });
    await render(draft);
    await act(async () => button("Delete")!.click());
    expect(api.send).not.toHaveBeenCalled();
    const [title, message, buttons] = api.alert.mock.calls[0] as [string, string, AlertButton[]];
    expect([title, message]).toEqual(['Delete "Weekly report"?', "This can't be undone."]);
    expect(buttons.map((item) => [item.text, item.style])).toEqual([
      ["Cancel", "cancel"],
      ["Delete", "destructive"],
    ]);
    await act(async () => buttons[1]!.onPress!());
    expect(api.send).toHaveBeenCalledExactlyOnceWith("skills/remove", { skillId: "skill-1" });
    expect(container.innerHTML).toBe("");
  });

  it("holds both answers while one is under way, so a draft is never answered twice", async () => {
    api.pending = 0;
    await render(draft);
    expect(button("Save")?.disabled).toBe(true);
    expect(button("Save")?.dataset.busy).toBe("true");
    expect(button("Delete")?.disabled).toBe(true);
  });

  it("says why a save or a delete failed", async () => {
    api.send.mockRejectedValue(new Error("Finish recording before saving"));
    await render(draft);
    await act(async () => button("Save")!.click());
    expect(api.alert).toHaveBeenCalledWith("Finish recording before saving");
    api.alert.mockReset();
    await act(async () => button("Delete")!.click());
    const buttons = api.alert.mock.calls[0]![2] as AlertButton[];
    await act(async () => buttons[1]!.onPress!());
    expect(api.alert).toHaveBeenLastCalledWith("Finish recording before saving");
    expect(button("Delete")).toBeDefined();
  });

  it("offers only Delete while typed values wait for a decision, or before the draft is read", async () => {
    api.review = { data: { values: [{ placeholder: "{{value 1}}" }], targets: [] }, error: null };
    await render(draft);
    expect(button("Save")).toBeUndefined();
    expect(button("Delete")).toBeDefined();
    api.review = { data: { values: [], targets: [{ id: "t1" }] }, error: null };
    await render({ ...draft });
    expect(button("Save")).toBeUndefined();
    api.review = { data: undefined, error: null };
    await render({ ...draft });
    expect(button("Save")).toBeUndefined();
  });

  it("shows nothing for a skill deleted elsewhere", async () => {
    api.review = { data: undefined, error: { code: "teach_skill_gone" } };
    await render(draft);
    expect(container.innerHTML).toBe("");
  });

  it("says a saved skill is saved, with no answer and no read", async () => {
    await render({ ...draft, status: "saved" });
    expect(container.textContent).toContain("Saved");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(api.enabled).toEqual([false]);
  });

  it("leaves out an empty when-to-use line", async () => {
    await render({ ...draft, playbook: { ...playbook, whenToUse: "" } });
    expect(container.textContent).not.toContain("When the owner");
    expect(container.querySelectorAll("p")).toHaveLength(3);
  });
});
