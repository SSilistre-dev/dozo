import type { MessageBlock, ThreadMessage, ThreadMessagePage } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { chatMarkdown, chatTimeFormatter, messageMarkdown } from "./dozo-chat-markdown.js";

let seq = 0;
function message(over: Partial<ThreadMessage> & { blocks: MessageBlock[] }): ThreadMessage {
  seq += 1;
  return {
    id: `m-${seq}`,
    threadId: "thread-1",
    seq,
    role: "user",
    createdAt: "2026-11-20T09:05:00.000Z",
    ...over,
  } as ThreadMessage;
}

const names = { bot: (id: string) => (id === "bot-1" ? "Ada" : undefined) };
const utc = chatTimeFormatter("UTC");
const text = (value: string): MessageBlock => ({ kind: "text", text: value });

describe("chatTimeFormatter", () => {
  it("writes the time in the reader's zone", () => {
    expect(chatTimeFormatter("Europe/Istanbul")("2026-11-20T09:05:00.000Z")).toBe(
      "2026-11-20 12:05",
    );
    expect(utc("2026-11-20T23:59:00.000Z")).toBe("2026-11-20 23:59");
  });

  it("falls back to UTC for an unknown or missing zone", () => {
    expect(chatTimeFormatter("Not/AZone")("2026-11-20T09:05:00.000Z")).toBe("2026-11-20 09:05");
    expect(chatTimeFormatter(undefined)("2026-11-20T09:05:00.000Z")).toBe("2026-11-20 09:05");
  });
});

describe("messageMarkdown", () => {
  it("heads a person's message with their name and a bot's with the bot's", () => {
    expect(
      messageMarkdown(
        message({ author: { id: "u-1", name: "Deniz" }, blocks: [text("Hi")] }),
        names,
        utc,
      ),
    ).toBe("**Deniz** · 2026-11-20 09:05\n\nHi");
    expect(
      messageMarkdown(
        message({ role: "bot", botId: "bot-1", blocks: [text("Hello")] }),
        names,
        utc,
      ),
    ).toBe("**Ada** · 2026-11-20 09:05\n\nHello");
  });

  it("keeps only the time when nobody is known", () => {
    expect(messageMarkdown(message({ blocks: [text("Hi")] }), names, utc)).toBe(
      "**2026-11-20 09:05**\n\nHi",
    );
    expect(messageMarkdown(message({ role: "bot", blocks: [text("Hello")] }), names, utc)).toBe(
      "**2026-11-20 09:05**\n\nHello",
    );
  });

  it("names attachments, pages, charts and calls without links, and tool steps by label", () => {
    const body = messageMarkdown(
      message({
        role: "bot",
        botId: "bot-1",
        blocks: [
          { kind: "image", artifactId: "a-1", mimeType: "image/png", name: "plan.png" },
          { kind: "file", artifactId: "a-2", mimeType: "text/csv", name: "costs.csv", size: 10 },
          { kind: "page", pageId: "p-1", version: 2, title: "Menu" },
          { kind: "chart", name: "Spend", spec: {}, data: [] } as unknown as MessageBlock,
          { kind: "voice_call", title: "Call about dinner", farewell: "Bye" },
          {
            kind: "steps",
            steps: [
              { label: "Web search", count: 2 },
              { label: "Shell", count: 1 },
            ],
          },
          { kind: "steps", steps: [] },
        ],
      }),
      names,
      utc,
    );
    expect(body).toBe(
      [
        "**Ada** · 2026-11-20 09:05",
        "📎 plan.png",
        "📎 costs.csv",
        "📄 Menu",
        "📊 Spend",
        "📞 Call about dinner",
        "_Web search ×2 · Shell_",
      ].join("\n\n"),
    );
    expect(body).not.toContain("a-1");
  });

  it("keeps questions, picked choices, cards and group messages", () => {
    const body = messageMarkdown(
      message({
        role: "bot",
        botId: "bot-1",
        blocks: [
          { kind: "ask", text: "Which day?", answer: "hidden detail", detail: "raw" },
          {
            kind: "choice",
            question: "Pick one",
            options: [
              { id: "a", letter: "A", label: "Soup" },
              { id: "b", letter: "B", label: "Salad" },
            ],
            answerId: "b",
          },
          { kind: "choice", question: "Open question", options: [] },
          { kind: "card", lines: [{ k: "Total", v: "3 items" }] },
          { kind: "card", lines: [] },
          { kind: "ask", text: "  " },
          {
            kind: "channel_message",
            provider: "chat",
            channelId: "c-1",
            fromAddress: "x",
            fromLabel: "Sam",
            text: "On my way",
          },
        ],
      }),
      names,
      utc,
    );
    expect(body).toBe(
      [
        "**Ada** · 2026-11-20 09:05",
        "Which day?",
        "Pick one\n→ Salad",
        "Open question",
        "Total: 3 items",
        "**Sam:** On my way",
      ].join("\n\n"),
    );
  });

  it("leaves out secrets, raw tool output, progress and what the transcript hides", () => {
    const hidden: MessageBlock[] = [
      { kind: "ask", text: "", input: "secret", answer: "hunter2" },
      { kind: "progress", text: "Running" },
      { kind: "meta", text: "meta" },
      {
        kind: "app",
        artifactId: "a-3",
        server: "s",
        tool: "t",
        toolArguments: { q: "secret-arg" },
        toolResult: { value: "secret-result" },
      },
      { kind: "text", text: "   " },
    ];
    expect(messageMarkdown(message({ blocks: hidden }), names, utc)).toBeUndefined();
    expect(
      messageMarkdown(message({ blocks: [{ kind: "delivery" }, text("prompt")] }), names, utc),
    ).toBeUndefined();
    expect(
      messageMarkdown(
        message({
          blocks: [{ kind: "bot_message_sent", toBotId: "b-2", toBotName: "Bo", text: "hey" }],
        }),
        names,
        utc,
      ),
    ).toBeUndefined();
    expect(
      messageMarkdown(message({ role: "system", blocks: [text("Cleared")] }), names, utc),
    ).toBeUndefined();
  });
});

describe("chatMarkdown", () => {
  const pages = (all: ThreadMessage[], size: number) => {
    const load = vi.fn(async (before: number | undefined): Promise<ThreadMessagePage> => {
      const older = all.filter((m) => before === undefined || m.seq < before);
      const page = older.slice(-size);
      const first = page[0];
      return {
        threadId: "thread-1",
        messages: page,
        olderCursor: first && older.length > page.length ? first.seq : null,
      };
    });
    return load;
  };
  const day = (n: number, value: string) =>
    message({
      createdAt: `2026-11-${String(n).padStart(2, "0")}T10:00:00.000Z`,
      author: { id: "u-1", name: "Deniz" },
      blocks: [text(value)],
    });

  it("reads every page and writes the chat oldest first under its title", async () => {
    const all = [day(1, "one"), day(2, "two"), day(3, "three")];
    const loadPage = pages(all, 2);
    const result = await chatMarkdown({ title: "Ada", loadPage, names, time: utc });
    expect(result.truncated).toBe(false);
    expect(result.markdown).toBe(
      `${[
        "# Ada",
        "**Deniz** · 2026-11-01 10:00\n\none",
        "**Deniz** · 2026-11-02 10:00\n\ntwo",
        "**Deniz** · 2026-11-03 10:00\n\nthree",
      ].join("\n\n")}\n`,
    );
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("stops at the start of the range without reading older pages", async () => {
    const all = [day(1, "one"), day(2, "two"), day(3, "three"), day(4, "four")];
    const loadPage = pages(all, 2);
    const result = await chatMarkdown({
      title: "Ada",
      loadPage,
      names,
      time: utc,
      since: new Date("2026-11-03T00:00:00.000Z"),
    });
    expect(result.markdown).toContain("three");
    expect(result.markdown).toContain("four");
    expect(result.markdown).not.toContain("two");
    expect(result.truncated).toBe(false);
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest messages and says so when the size limit is reached", async () => {
    const all = [day(1, "one"), day(2, "two"), day(3, "three")];
    const one = messageMarkdown(all[2]!, names, utc)!.length;
    const result = await chatMarkdown({
      title: "Ada",
      loadPage: pages(all, 10),
      names,
      time: utc,
      maxChars: one * 2,
    });
    expect(result.truncated).toBe(true);
    expect(result.markdown).toContain("three");
    expect(result.markdown).toContain("two");
    expect(result.markdown).not.toContain("one");
  });

  it("writes only the title for an empty chat", async () => {
    const result = await chatMarkdown({ title: "Ada", loadPage: pages([], 10), names, time: utc });
    expect(result).toEqual({ markdown: "# Ada\n", truncated: false });
  });
});
