import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { BenchTask } from "./dozo-token-bench.js";

/** Synthetic filler with a stable length; each line is distinct so no two documents share text. */
export function filler(label: string, lines: number) {
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

/** The fixed task set. Changing it changes the baseline: bump BENCH_VERSION with it. */
export const TOKEN_BENCH_TASKS: readonly BenchTask[] = [
  { id: "chat-1-turn", kind: "short-chat", turns: chatTurns(1) },
  { id: "chat-3-turns", kind: "short-chat", turns: chatTurns(3) },
  { id: "chat-6-turns", kind: "short-chat", turns: chatTurns(6) },
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
];
