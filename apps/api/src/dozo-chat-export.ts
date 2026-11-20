import { chatMarkdown, chatTimeFormatter } from "./dozo-chat-markdown.js";
import type { RouterContext } from "./routes/context.js";
import { loadMessagePage } from "./thread-message-pages.js";
import { resolveThreadTarget } from "./thread-target.js";

const PAGE_SIZE = 200;

/**
 * One chat as Markdown. Access and the messages shown are the transcript's own: the same target
 * check (a bot or group in the caller's Space) and the same page reader, so a member exports what
 * they can already scroll through and nothing more.
 */
export function dozoChatExportRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoChatExport: {
      markdown: authed.dozoChatExport.markdown.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, input, {
          includeArchived: true,
        });
        const botNames = new Map<string, string>(
          target.kind === "bot"
            ? [[target.botId, target.bot.name]]
            : target.members.map((member) => [member.botId, member.name]),
        );
        // Bots that left a group still signed their messages: read their names in this Space.
        const pending = new Set<string>();
        const result = await chatMarkdown({
          title: target.kind === "bot" ? target.bot.name : target.groupName,
          loadPage: async (before) => {
            const page = await loadMessagePage(deps.prisma, target.threadId, before, PAGE_SIZE);
            for (const message of page.messages) {
              if (message.botId && !botNames.has(message.botId)) pending.add(message.botId);
            }
            if (pending.size) {
              const bots = await deps.prisma.bot.findMany({
                where: { id: { in: [...pending] }, spaceId: context.actor.spaceId },
                select: { id: true, name: true },
              });
              for (const bot of bots) botNames.set(bot.id, bot.name);
              pending.clear();
            }
            return page;
          },
          names: { bot: (botId) => botNames.get(botId) },
          time: chatTimeFormatter(input.timeZone),
          since: input.since ? new Date(input.since) : undefined,
        });
        return result;
      }),
    },
  };
}
