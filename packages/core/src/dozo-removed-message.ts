/**
 * The message an update takes back, such as the old reply of an edited or regenerated turn. It
 * rides on `thread.message.updated` with `removed: true` instead of a new event type, so an app
 * built before it still parses the stream and drops the message on its next read.
 */
export function dozoRemovedMessageId(event: {
  type: string;
  payload?: Record<string, unknown>;
}): string | null {
  const payload = event.payload;
  if (event.type !== "thread.message.updated" || payload?.removed !== true) return null;
  return typeof payload.messageId === "string" ? payload.messageId : null;
}
