import { describe, expect, it } from "vitest";
import { ClientError } from "./client-error.js";
import type { TeachRecordingEvent } from "./dozo-teach-playbook.js";
import {
  applyValueDecisions,
  buildPlaybookFromRecording,
  formatSkillRunPrompt,
  promptInvokesSkill,
  typedValuesFromRecording,
} from "./dozo-teach-playbook.js";
import * as core from "./index.js";
import { formatSkillRunPrompt as upstreamFormatSkillRunPrompt } from "./teach-playbook.js";

const at = "2026-01-01T00:00:00.000Z";

function typing(text: string, extra: Partial<TeachRecordingEvent> = {}): TeachRecordingEvent[] {
  return [...text].map((key) => ({ at, kind: "key", key, ...extra }));
}

/** A sign-in: an email, an unprotected password, a protected run, a paste and a key. */
const signIn: TeachRecordingEvent[] = [
  { at, kind: "pointer", x: 10, y: 20, type: "click" },
  ...typing("ali@example.test"),
  { at, kind: "key", key: "Tab" },
  ...typing("Gizli-5678"),
  { at, kind: "pointer", x: 30, y: 40, type: "click" },
  { at, kind: "key", sensitive: true },
  { at, kind: "key", sensitive: true },
  { at, kind: "clipboard", text: "weekly-export.csv" },
  { at, kind: "clipboard", sensitive: true },
  { at, kind: "clipboard", text: "my api_key" },
  { at, kind: "key", key: "Enter" },
];

describe("the package export", () => {
  it("serves the fork's builder and run prompt under upstream's names", () => {
    expect(core.buildPlaybookFromRecording).toBe(buildPlaybookFromRecording);
    expect(core.formatSkillRunPrompt).toBe(formatSkillRunPrompt);
    expect(core.typedValuesFromRecording).toBe(typedValuesFromRecording);
    expect(promptInvokesSkill("run Export list", "Export list")).toBe(true);
  });
});

describe("buildPlaybookFromRecording", () => {
  const playbook = buildPlaybookFromRecording("Sign in", signIn, [
    { at, summary: "Dashboard open" },
  ]);

  it("never puts typed or pasted text in the steps", () => {
    const text = JSON.stringify(playbook);
    for (const secret of ["ali@example.test", "Gizli-5678", "weekly-export.csv", "api_key"]) {
      expect(text).not.toContain(secret);
    }
    expect(playbook.steps).toEqual([
      "Click left button at (10, 20).",
      "Type {{value 1}}.",
      "Press key: Tab.",
      "Type {{value 2}}.",
      "Click left button at (30, 40).",
      "Type {{value 3}}.",
      "Type {{value 4}}.",
      "Type {{value 5}}.",
      "Type {{value 6}}.",
      "Press key: Enter.",
    ]);
  });

  it("lists the goal, then each value, marked when secret", () => {
    expect(playbook.inputs).toEqual([
      "Sign in",
      "value 1",
      "value 2",
      "value 3 (secret)",
      "value 4",
      "value 5 (secret)",
      "value 6 (secret)",
    ]);
    expect(playbook.howToCheck).toContain("Dashboard open");
  });

  it("keeps upstream's inputs, steps and defaults without typed values", () => {
    const events: TeachRecordingEvent[] = [
      { at, kind: "pointer", x: 1, y: 2, type: "down" },
      { at, kind: "pointer", x: 50, y: 60, type: "move" },
      { at, kind: "pointer", x: 50, y: 60, type: "up" },
      { at, kind: "pointer", x: 5, y: 5, type: "down" },
      { at, kind: "pointer", x: 6, y: 6, type: "up" },
      { at, kind: "pointer", x: 7, y: 7, type: "up" },
      { at, kind: "pointer", x: 8, y: 8, type: "move" },
      { at, kind: "pointer", type: "down" },
      { at, kind: "pointer", x: 9, y: 9, type: "down" },
      { at, kind: "pointer", x: 3, y: 4, button: "right", type: "click" },
      { at, kind: "pointer", type: "dblclick" },
      { at, kind: "scroll", type: "up", text: "4", x: 1, y: 1 },
      { at, kind: "scroll" },
      { at, kind: "snapshot", summary: "Saved" },
      { at, kind: "key" },
      { at, kind: "clipboard", text: "" },
    ];
    const built = buildPlaybookFromRecording(" Move ", events);
    expect(built.inputs).toEqual(["Move"]);
    expect(built.steps).toEqual([
      "Drag left button from (1, 2) to (50, 60).",
      "Click left button at (5, 5).",
      "Release left button at (7, 7).",
      "Move pointer to (8, 8).",
      "Click left button at (0, 0).",
      "Click left button at (9, 9).",
      "Click right button at (3, 4).",
      "dblclick left button at (0, 0).",
      "Scroll up 4 times at (1, 1).",
      "Scroll down 3 times.",
    ]);
    const empty = buildPlaybookFromRecording("", []);
    expect(empty.inputs).toEqual([]);
    expect(empty.steps.length).toBe(1);
    expect(empty.whenToUse.length).toBeGreaterThan(0);
  });

  it("splits typed and protected runs that follow each other", () => {
    const built = buildPlaybookFromRecording("x", [
      ...typing("ab"),
      { at, kind: "key", sensitive: true },
      ...typing("c"),
    ]);
    expect(built.steps).toEqual(["Type {{value 1}}.", "Type {{value 2}}.", "Type {{value 3}}."]);
  });
});

describe("typedValuesFromRecording", () => {
  it("numbers the values as the playbook does", () => {
    expect(typedValuesFromRecording(signIn)).toEqual([
      { placeholder: "{{value 1}}", text: "ali@example.test", secret: false },
      { placeholder: "{{value 2}}", text: "Gizli-5678", secret: false },
      { placeholder: "{{value 3}}", text: null, secret: true },
      { placeholder: "{{value 4}}", text: "weekly-export.csv", secret: false },
      { placeholder: "{{value 5}}", text: null, secret: true },
      { placeholder: "{{value 6}}", text: "my api_key", secret: true },
    ]);
  });
});

describe("applyValueDecisions", () => {
  const playbook = buildPlaybookFromRecording("Sign in", signIn);
  const values = typedValuesFromRecording(signIn);

  it("turns values into named inputs, fixed text or nothing", () => {
    const applied = applyValueDecisions(playbook, values, {
      "{{value 1}}": { action: "variable", name: "E-posta Adresi" },
      "{{value 2}}": { action: "variable", name: "Şifre" },
      "{{value 3}}": { action: "variable", name: "password" },
      "{{value 4}}": { action: "fixed" },
      "{{value 5}}": { action: "remove" },
      "{{value 6}}": { action: "variable", name: "ŞİFRE" },
    });
    expect(applied.steps).toEqual([
      "Click left button at (10, 20).",
      "Type {{e_posta_adresi}}.",
      "Press key: Tab.",
      "Type {{sifre}}.",
      "Click left button at (30, 40).",
      "Type {{password}}.",
      'Type "weekly-export.csv".',
      "Type {{sifre}}.",
      "Press key: Enter.",
    ]);
    // Inputs are exactly the variables; a name shared with a secret value is secret.
    expect(applied.inputs).toEqual(["e_posta_adresi", "sifre (secret)", "password (secret)"]);
    expect(JSON.stringify(applied)).not.toContain("Gizli-5678");
  });

  it("names an undecided or unnameable value after its number, at most 40 characters", () => {
    const applied = applyValueDecisions(playbook, values, {
      "{{value 1}}": { action: "variable", name: "!!!" },
      "{{value 2}}": { action: "variable", name: `${"a".repeat(39)}_b` },
    });
    expect(applied.inputs).toEqual([
      "value_1",
      "a".repeat(39),
      "value_3 (secret)",
      "value_4",
      "value_5 (secret)",
      "value_6 (secret)",
    ]);
  });

  it("refuses to keep a secret value as text", () => {
    for (const placeholder of ["{{value 3}}", "{{value 6}}"]) {
      expect(() =>
        applyValueDecisions(playbook, values, { [placeholder]: { action: "fixed" } }),
      ).toThrow(ClientError);
    }
  });

  it("leaves alone values whose steps were edited away", () => {
    const edited = {
      ...playbook,
      steps: playbook.steps.filter((step) => !/value [36]\b/.test(step)),
    };
    // A secret value no step holds is not refused: there is nothing to keep.
    const applied = applyValueDecisions(edited, values, { "{{value 3}}": { action: "fixed" } });
    expect(applied.inputs).toEqual(["value_1", "value_2", "value_4", "value_5 (secret)"]);
  });

  it("keeps the goal and drops the value labels when nothing stays an input", () => {
    const typed = [...typing("hi"), { at, kind: "key", key: "Enter" } as TeachRecordingEvent];
    const built = buildPlaybookFromRecording("Greet", typed);
    const kept = applyValueDecisions(built, typedValuesFromRecording(typed), {
      "{{value 1}}": { action: "fixed" },
    });
    expect(kept).toMatchObject({ inputs: ["Greet"], steps: ['Type "hi".', "Press key: Enter."] });
    const removed = applyValueDecisions(
      buildPlaybookFromRecording("Greet", typing("hi")),
      typedValuesFromRecording(typing("hi")),
      { "{{value 1}}": { action: "remove" } },
    );
    expect(removed.inputs).toEqual(["Greet"]);
    expect(removed.steps.length).toBe(1);
    expect(removed.steps[0]).not.toContain("{{");
  });
});

describe("formatSkillRunPrompt", () => {
  const applied = applyValueDecisions(
    buildPlaybookFromRecording("Sign in", signIn),
    typedValuesFromRecording(signIn),
    {
      "{{value 1}}": { action: "variable", name: "email" },
      "{{value 2}}": { action: "variable", name: "password" },
      "{{value 4}}": { action: "fixed" },
      "{{value 5}}": { action: "remove" },
      "{{value 6}}": { action: "remove" },
    },
  );

  it("is upstream's prompt when the steps have no inputs", () => {
    const plain = buildPlaybookFromRecording("Open", [
      { at, kind: "pointer", x: 1, y: 1, type: "click" },
    ]);
    expect(formatSkillRunPrompt("Open", plain, true)).toBe(
      upstreamFormatSkillRunPrompt("Open", plain, true),
    );
  });

  it("says where inputs come from and how secret ones are typed", () => {
    const prompt = formatSkillRunPrompt("Sign in", applied, true);
    expect(prompt.startsWith(upstreamFormatSkillRunPrompt("Sign in", applied, true))).toBe(true);
    expect(prompt).toContain("{{email}}, {{password}}, {{value_3}}");
    expect(prompt).toContain("Secret inputs ({{password}}, {{value_3}})");
    expect(prompt).toContain("browser_act fill_secret");
    expect(prompt).not.toContain("Given inputs");
  });

  it("lists given values, never a secret one", () => {
    const prompt = formatSkillRunPrompt("Sign in", applied, false, {
      email: "ali@example.test",
      password: "Gizli-5678",
      other: "unused",
    });
    expect(prompt).toContain('Given inputs:\n- email: "ali@example.test"');
    expect(prompt).not.toContain("Gizli-5678");
    expect(prompt).not.toContain("unused");
  });

  it("asks without the secret note when no input is secret", () => {
    const typed = typing("hi");
    const prompt = formatSkillRunPrompt(
      "Greet",
      applyValueDecisions(
        buildPlaybookFromRecording("Greet", typed),
        typedValuesFromRecording(typed),
        {},
      ),
    );
    expect(prompt).toContain("{{value_1}}");
    expect(prompt).not.toContain("Secret inputs");
  });
});
