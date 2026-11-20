import type * as z from "zod";

/** Every bodied request the relay takes is a small JSON object. */
const MAX_BODY = 4096;
/** What a refused caller is told to wait before it tries again. */
export const RETRY_AFTER_SECONDS = 60;

/**
 * Answers carry no detail, so an unknown channel and a wrong token look the same. `429` says
 * when to try again.
 */
export function relayResponse(status: number, body?: unknown) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (status === 429) headers.set("Retry-After", String(RETRY_AFTER_SECONDS));
  if (body === undefined) return new Response(null, { status, headers });
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

/** The parsed body, or null when it is too large, not JSON or not the expected shape. */
export async function readJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T> | null> {
  const text = await readCapped(request);
  if (text === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The body as text, read no further than `MAX_BODY` bytes; null when it is longer. */
async function readCapped(request: Request) {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}
