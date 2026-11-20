import type { MessageBlock, ThreadMessage, ThreadMessagePage } from "@rakazo/contracts";
import { isPeerReceiptBlocks } from "@rakazo/core";

/** Where the export stops taking earlier messages, so one answer stays a sensible size. */
export const CHAT_EXPORT_MAX_CHARS = 2_000_000;

export type ChatMarkdownNames = {
  /** The bot's name for a bot message. */
  bot: (botId: string) => string | undefined;
};

/**
 * A message time as `2026-11-20 14:05` in the reader's zone. An unknown zone falls back to UTC
 * rather than refusing the export.
 */
export function chatTimeFormatter(timeZone: string | undefined): (iso: string) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return chatTimeFormatter("UTC");
  }
  return (iso) => {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  };
}

/**
 * What a block shows in the export. Attachments, pages and charts keep only their name and no
 * link; tool activity keeps only its step labels. Cards that ask for secrets, connect accounts or
 * approve tools, raw tool output and progress lines are left out.
 */
function blockMarkdown(block: MessageBlock): string | undefined {
  switch (block.kind) {
    case "text":
      return block.text.trim() || undefined;
    case "ask":
      return block.text.trim() || undefined;
    case "choice": {
      const picked = block.options.find((option) => option.id === block.answerId);
      return picked ? `${block.question}\n→ ${picked.label}` : block.question;
    }
    case "card":
      return block.lines.map((line) => `${line.k}: ${line.v}`).join("\n") || undefined;
    case "image":
    case "file":
      return `📎 ${block.name}`;
    case "page":
      return `📄 ${block.title}`;
    case "chart":
      return `📊 ${block.name}`;
    case "voice_call":
      return `📞 ${block.title}`;
    case "channel_message":
      return `**${block.fromLabel}:** ${block.text}`;
    case "steps": {
      const labels = block.steps.map((step) =>
        step.count > 1 ? `${step.label} ×${step.count}` : step.label,
      );
      return labels.length ? `_${labels.join(" · ")}_` : undefined;
    }
    default:
      return undefined;
  }
}

/** One message as a heading line and its body, or nothing when it has nothing to show. */
export function messageMarkdown(
  message: ThreadMessage,
  names: ChatMarkdownNames,
  time: (iso: string) => string,
): string | undefined {
  if (message.role === "system") return undefined;
  // A delivery is the prompt that woke the bot, and receipts are chips the transcript hides.
  if (message.blocks.some((block) => block.kind === "delivery")) return undefined;
  if (isPeerReceiptBlocks(message.blocks)) return undefined;
  const body = message.blocks.flatMap((block) => blockMarkdown(block) ?? []).join("\n\n");
  if (!body) return undefined;
  const who =
    message.role === "bot"
      ? message.botId
        ? names.bot(message.botId)
        : undefined
      : message.author?.name;
  const when = time(message.createdAt);
  return `${who ? `**${who}** · ${when}` : `**${when}**`}\n\n${body}`;
}

/**
 * Reads the chat newest page first and renders it oldest first. Stops at `since`, or when the
 * size limit is reached, keeping the newest messages and saying so.
 */
export async function chatMarkdown(input: {
  title: string;
  loadPage: (before: number | undefined) => Promise<ThreadMessagePage>;
  names: ChatMarkdownNames;
  time: (iso: string) => string;
  since?: Date;
  maxChars?: number;
}): Promise<{ markdown: string; truncated: boolean }> {
  const maxChars = input.maxChars ?? CHAT_EXPORT_MAX_CHARS;
  const sections: string[] = [];
  let size = 0;
  let before: number | undefined;
  do {
    const page = await input.loadPage(before);
    for (const message of [...page.messages].reverse()) {
      if (input.since && new Date(message.createdAt) < input.since) {
        return done(input.title, sections, false);
      }
      const section = messageMarkdown(message, input.names, input.time);
      if (!section) continue;
      if (size + section.length > maxChars) return done(input.title, sections, true);
      size += section.length;
      sections.push(section);
    }
    before = page.olderCursor ?? undefined;
  } while (before !== undefined);
  return done(input.title, sections, false);
}

function done(title: string, newestFirst: string[], truncated: boolean) {
  const body = [`# ${title}`, ...newestFirst.reverse()].join("\n\n");
  return { markdown: `${body}\n`, truncated };
}
