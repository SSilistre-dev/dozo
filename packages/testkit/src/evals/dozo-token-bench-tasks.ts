import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { SkillPlaybook, TeachRecordingEvent } from "@rakazo/core";
import {
  applyValueDecisions,
  buildPlaybookFromRecording,
  formatSkillRunPrompt,
  typedValuesFromRecording,
  withClickTargets,
} from "@rakazo/core";
import type { BenchTask } from "./dozo-token-bench.js";

/** Synthetic filler with a stable length; each line is distinct so no two documents share text. */
function filler(label: string, lines: number) {
  return Array.from(
    { length: lines },
    (_, i) =>
      `${label} line ${i + 1}: the quarterly review notes steady progress on item ${(i * 7) % 97}, with one open question about scope.`,
  ).join("\n");
}

function conversation(messages: number, label: string): AgentRunRequest["history"] {
  return Array.from({ length: messages }, (_, i) =>
    i % 2 === 0
      ? { role: "user" as const, content: `${label} question ${i / 2 + 1}: ${filler(label, 1)}` }
      : {
          role: "assistant" as const,
          content: `${label} answer ${(i + 1) / 2}: ${filler(`${label}-a${i}`, 3)}`,
        },
  );
}

const page = (url: string, lines: number) => ({
  url,
  title: `Page ${url}`,
  text: filler(url, lines),
});

const browse = (pages: number, lines: number): BenchTask => ({
  id: `browse-${pages}-pages`,
  kind: "multi-page",
  turns: [
    {
      prompt: `Read the ${pages} pages of the synthetic report and summarize the open questions.`,
      replies: [
        ...Array.from({ length: pages }, (_, i) => ({
          tool: "browser_navigate",
          args: { url: `https://report.example.test/p${i + 1}` },
        })),
        { text: "The open questions are about scope on every page." },
      ],
    },
  ],
  toolResult: (_name, args) => page(String(args.url), lines),
});

const bigResult = (id: string, lines: number): BenchTask => ({
  id,
  kind: "long-tool-result",
  turns: [
    {
      prompt: "Fetch the synthetic export and tell me how many items are open.",
      replies: [
        { tool: "web_fetch", args: { url: "https://export.example.test/all" } },
        { text: "Twelve items are open." },
      ],
    },
    {
      prompt: "Which one is the oldest?",
      replies: [{ text: "Item 3 is the oldest." }],
    },
  ],
  toolResult: () => ({ export: filler(id, lines) }),
});

const chatTurns = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    prompt: `Short question ${i + 1}: what should I do next about item ${i + 1}?`,
    replies: [{ text: `Check item ${i + 1} first, then report back.` }],
  }));

const recallTurns = (count: number, recalled: boolean) =>
  Array.from({ length: count }, (_, i) => ({
    prompt: `What did we decide about topic ${i + 1}?`,
    ...(recalled
      ? { recalled: [`The team decided topic ${i + 1} ships after review.`, filler(`m${i}`, 4)] }
      : {}),
    replies: [{ text: `Topic ${i + 1} ships after review.` }],
  }));

/*
 * One form fill on one fixed fake page, three ways: no skill, a skill in the format taught skills
 * were saved in before (coordinates, the typed text written in), and the new format (inputs the
 * run is given, each click named with its window). The model is scripted, so these show what each
 * prompt costs to send, not whether better steps would need fewer retries or calls. (b) and (c)
 * script exactly the same calls, so their difference is the prompt alone; (a) explores the page
 * a step at a time, as a model with nothing to follow does.
 */
const FORM_URL = "https://form.example.test/contact";
const FORM_GOAL = "Fill in the contact form";
const FORM_SKILL = "Fill contact form";
const FORM_WINDOW = "Contact – Chromium";
const FORM_VALUES = { full_name: "Ada Lovelace", email: "ada@example.test" };

/** The page as the browser tools describe it: a fixed accessibility snapshot. */
const FORM_SNAPSHOT = [
  `url: ${FORM_URL}`,
  "title: Contact us",
  "- banner:",
  '  - link "Home" [ref=e1]',
  '  - link "Pricing" [ref=e2]',
  "- main:",
  '  - heading "Contact us" [level=1]',
  "  - paragraph: Tell us what you need and we will answer within two working days.",
  "  - form:",
  '    - textbox "Full name" [ref=e3]',
  '    - textbox "Email" [ref=e4]',
  '    - button "Send message" [ref=e5]',
  "- contentinfo:",
  "  - paragraph: Example Company, 1 Example Street",
  '  - link "Privacy" [ref=e6]',
  '  - link "Terms" [ref=e7]',
].join("\n");

const formResult = (name: string, args: Record<string, unknown>) =>
  name === "browser_act"
    ? { ok: true, url: FORM_URL, actions: (args.actions as unknown[]).length }
    : { url: FORM_URL, title: "Contact us", snapshot: FORM_SNAPSHOT };

const typing = (text: string): TeachRecordingEvent[] =>
  [...text].map((key) => ({ at: "2026-01-01T00:00:00.000Z", kind: "key", key }));
const click = (x: number, y: number): TeachRecordingEvent => ({
  at: "2026-01-01T00:00:00.000Z",
  kind: "pointer",
  x,
  y,
  button: "left",
  type: "click",
});

/** What the teacher did: the name field, the email field, then Send (5 steps). */
const formRecording = [
  click(208, 206),
  ...typing(FORM_VALUES.full_name),
  click(208, 262),
  ...typing(FORM_VALUES.email),
  click(330, 340),
];
const formClicks = formRecording.flatMap((event, eventIndex) =>
  event.kind === "pointer" ? [eventIndex] : [],
);

const formSkillRecord = {
  id: "skill-contact",
  createdAt: "2026-01-01T00:00:00.000Z",
  name: FORM_SKILL,
};

/** Skills saved before: coordinates, and what was typed written into the step. */
const oldFormPlaybook: SkillPlaybook = {
  ...buildPlaybookFromRecording(FORM_GOAL, formRecording),
  inputs: [FORM_GOAL],
  steps: [
    "Click left button at (208, 206).",
    `Type ${JSON.stringify(FORM_VALUES.full_name)}.`,
    "Click left button at (208, 262).",
    `Type ${JSON.stringify(FORM_VALUES.email)}.`,
    "Click left button at (330, 340).",
  ],
};

/** Skills saved now: inputs the run is given, and what each click hit. */
const newFormPlaybook: SkillPlaybook = withClickTargets(
  applyValueDecisions(
    buildPlaybookFromRecording(FORM_GOAL, formRecording),
    typedValuesFromRecording(formRecording),
    {
      "{{value 1}}": { action: "variable", name: "full_name" },
      "{{value 2}}": { action: "variable", name: "email" },
    },
  ),
  formRecording,
  [
    { eventIndex: formClicks[0]!, window: FORM_WINDOW, label: "Full name field" },
    { eventIndex: formClicks[1]!, window: FORM_WINDOW, label: "Email field" },
    { eventIndex: formClicks[2]!, window: FORM_WINDOW, label: "Send message button" },
  ],
);

const fillAction = (ref: string, text: string) => [
  { kind: "click", ref },
  { kind: "fill", ref, text },
];

/** Opening the page and reading it, then what a skill run does: all the actions in one call. */
const formSkillReplies: BenchTask["turns"][number]["replies"] = [
  { tool: "browser_navigate", args: { url: FORM_URL } },
  { tool: "browser_snapshot", args: {} },
  {
    tool: "browser_act",
    args: {
      actions: [
        ...fillAction("e3", FORM_VALUES.full_name),
        ...fillAction("e4", FORM_VALUES.email),
        { kind: "click", ref: "e5" },
      ],
    },
  },
  { tool: "browser_snapshot", args: {} },
  { text: "The contact form is filled in and sent." },
];

const formTask = (id: string, prompt: string, replies: typeof formSkillReplies): BenchTask => ({
  id,
  kind: "multi-page",
  ...(id === "form-fill-no-skill" ? {} : { records: [formSkillRecord] }),
  turns: [{ prompt, replies }],
  toolResult: formResult,
});

/** Exported for the test that holds (b) and (c) to the same calls. */
export const FORM_FILL_TASKS: readonly BenchTask[] = [
  formTask(
    "form-fill-no-skill",
    `Fill in the contact form at ${FORM_URL} with the name ${FORM_VALUES.full_name} and the email ${FORM_VALUES.email}, then send it.`,
    [
      { tool: "browser_navigate", args: { url: FORM_URL } },
      { tool: "browser_snapshot", args: {} },
      { tool: "browser_act", args: { actions: fillAction("e3", FORM_VALUES.full_name) } },
      { tool: "browser_snapshot", args: {} },
      { tool: "browser_act", args: { actions: fillAction("e4", FORM_VALUES.email) } },
      { tool: "browser_snapshot", args: {} },
      { tool: "browser_act", args: { actions: [{ kind: "click", ref: "e5" }] } },
      { tool: "browser_snapshot", args: {} },
      { text: "The contact form is filled in and sent." },
    ],
  ),
  formTask("form-fill-old-skill", formSkillRunPrompt(oldFormPlaybook), formSkillReplies),
  formTask(
    "form-fill-new-skill",
    formSkillRunPrompt(newFormPlaybook, FORM_VALUES),
    formSkillReplies,
  ),
];

function formSkillRunPrompt(playbook: SkillPlaybook, values?: Record<string, string>) {
  return formatSkillRunPrompt(FORM_SKILL, playbook, false, values);
}

/** The fixed task set. Changing it changes the baseline: bump BENCH_VERSION with it. */
export const TOKEN_BENCH_TASKS: readonly BenchTask[] = [
  { id: "chat-1-turn", kind: "short-chat", turns: chatTurns(1) },
  { id: "chat-3-turns", kind: "short-chat", turns: chatTurns(3) },
  { id: "chat-6-turns", kind: "short-chat", turns: chatTurns(6) },
  // chat-3-turns on a plan without computer hours (Free): no computer tools, the no-computer line.
  { id: "chat-3-turns-no-computer", kind: "short-chat", turns: chatTurns(3), computer: "none" },
  {
    id: "chat-with-history",
    kind: "short-chat",
    history: conversation(8, "intro"),
    turns: chatTurns(2),
  },
  bigResult("tool-result-8k", 70),
  bigResult("tool-result-40k", 340),
  bigResult("tool-result-120k", 1000),
  browse(3, 40),
  browse(6, 60),
  browse(10, 80),
  {
    id: "history-64",
    kind: "long-history",
    history: conversation(64, "h64"),
    turns: chatTurns(2),
  },
  {
    id: "history-90",
    kind: "long-history",
    history: conversation(90, "h90"),
    turns: chatTurns(3),
  },
  {
    id: "history-140",
    kind: "long-history",
    history: conversation(140, "h140"),
    turns: chatTurns(2),
  },
  {
    id: "history-140-6-turns",
    kind: "long-history",
    history: conversation(140, "h140l"),
    turns: chatTurns(6),
  },
  {
    id: "memory-in-system",
    kind: "memory-recall",
    memoryContext: `<memory>\n${filler("memory", 30)}\n</memory>`,
    turns: recallTurns(3, false),
  },
  {
    id: "memory-recall-each-turn",
    kind: "memory-recall",
    history: conversation(20, "mr"),
    turns: recallTurns(3, true),
  },
  {
    id: "memory-tool-lookup",
    kind: "memory-recall",
    turns: [
      {
        prompt: "What do you remember about the launch plan?",
        replies: [
          { tool: "recall_memory", args: { query: "launch plan" } },
          { text: "The launch plan ships after review." },
        ],
      },
      {
        prompt: "And the budget?",
        replies: [
          { tool: "recall_memory", args: { query: "budget" } },
          { text: "The budget is unchanged." },
        ],
      },
    ],
    toolResult: (_name, args) => ({
      results: [{ memory: `${String(args.query)}: ${filler(String(args.query), 6)}` }],
    }),
  },
  {
    id: "records-reordered",
    kind: "short-chat",
    // Postgres returns unordered rows in storage order, which an update changes (a plugin's status
    // sync rewrites its row), so the same skills and plugins can be listed in another order.
    records: Array.from({ length: 6 }, (_, i) => ({
      id: `rec${i + 1}`,
      createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      name: `Saved record ${i + 1}`,
    })),
    turns: chatTurns(3).map((turn, i) => ({
      ...turn,
      recordOrder: [
        [0, 1, 2, 3, 4, 5],
        [1, 2, 3, 4, 5, 0],
        [2, 3, 4, 5, 0, 1],
      ][i],
    })),
  },
  {
    id: "disk-filling",
    kind: "short-chat",
    // A build fills the bot computer's 40 GB disk past the 85% note, a few hundred MB per turn.
    turns: chatTurns(4).map((turn, i) => ({
      ...turn,
      disk: { usedGb: 35.2 + i * 0.3, freeGb: 4.8 - i * 0.3 },
    })),
  },
  {
    id: "rare-tool-needed",
    kind: "short-chat",
    // A rarely used built-in, called on the second turn: listed it is one call, deferred it is
    // reached through find_tool and use_tool.
    turns: [
      chatTurns(1)[0]!,
      {
        prompt: "Remind me tomorrow at 9 to send the weekly report.",
        replies: [
          {
            builtin: "schedule_create",
            args: {
              name: "Weekly report",
              prompt: "Remind the user to send the weekly report.",
              runAt: "2026-01-02T09:00:00Z",
            },
          },
          { text: "I will remind you tomorrow at 9." },
        ],
      },
      chatTurns(2)[1]!,
    ],
  },
  {
    id: "parallel-tools",
    kind: "multi-page",
    turns: [
      {
        prompt: "Compare the three synthetic pricing pages.",
        replies: [
          {
            tools: [1, 2, 3].map((n) => ({
              tool: "web_fetch",
              args: { url: `https://compare.example.test/${n}` },
            })),
          },
          { text: "Page 2 lists the most items." },
        ],
      },
    ],
    toolResult: (_name, args) => page(String(args.url), 50),
  },
  ...FORM_FILL_TASKS,
];
