/** What the receiving bot is asked to do: the sender's note, then the recent chat as context. */
export function directHandoffTaskPrompt(input: {
  fromName: string;
  note: string;
  conversation: string;
}): string {
  const head = `${input.fromName} handed you its conversation with the user. Carry on with it here, in your own chat with the user.\n\n${input.fromName}'s note:\n${input.note}`;
  if (!input.conversation) return head;
  const fenced = input.conversation.replace(/<\s*\/\s*conversation\s*>/gi, "&lt;/conversation&gt;");
  return `${head}\n\nThe latest messages of that chat, as context:\n<conversation>\n${fenced}\n</conversation>`;
}

/** The handing bot's tool result: its turn ends with one line. */
export function directHandoffDoneNote(toName: string): string {
  return `Handed to ${toName}, which continues in its own chat with the user; both chats show the handoff. End your turn now with one short line telling the user ${toName} is taking over. Make no more tool calls.`;
}

export const DIRECT_HANDOFF_OWN_BOTS_ONLY =
  "Only the user's own bots can take over this chat; message_bot reaches the others.";

/** One message of the handing bot's chat as the receiving bot reads it. */
export function conversationLine(speaker: string | undefined, text: string): string {
  return `${speaker ?? "User"}: ${text}`;
}
