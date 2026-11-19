import { t } from "@lingui/core/macro";
import { authCapabilitiesSchema, isPrivateNetworkHost } from "@rakazo/contracts";
import { cancelResponseBody, readBoundedJsonResponse, withAbort } from "@rakazo/core";
import type { EndpointResult } from "./endpoint";
import { MAX_API_PROBE_RESPONSE_BYTES, normalizeApiBase, probeApiBase } from "./endpoint";

/** Short: the person is waiting on the Server screen, and a second address may follow. */
export const SERVER_PROBE_TIMEOUT_MS = 6_000;

type Outcome = "ok" | "timeout" | "unreachable" | "foreign";

/**
 * Checks an address before the Server screen saves it, saying why it failed: no answer in time, no
 * answer at all (a wrong name, a server that is down, a refused certificate: the platform reports
 * them alike), or an answer from something that is not a Dozo server. An address that fails with
 * or without `www.` is tried the other way once, and the one that answers is used. The server's
 * own health check then runs as before.
 */
export async function probeDozoServer(
  input: string,
  fetchImpl: typeof fetch = fetch,
  headers: Record<string, string> = {},
): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok)
    return parsed.error === "Public servers need https://"
      ? { ok: false, error: t`Public servers need https://` }
      : parsed;
  let url = parsed.url;
  let outcome = await capabilities(url, fetchImpl, headers);
  const other = wwwAlternative(url);
  if ((outcome === "unreachable" || outcome === "foreign") && other) {
    if ((await capabilities(other, fetchImpl, headers)) === "ok") {
      url = other;
      outcome = "ok";
    }
  }
  if (outcome === "timeout")
    return { ok: false, error: t`The server did not answer in time. Try again.` };
  if (outcome === "unreachable")
    return { ok: false, error: t`Could not reach this address. Check it and your connection.` };
  if (outcome === "foreign") return { ok: false, error: t`This address is not a Dozo server.` };
  return probeApiBase(url, fetchImpl, headers);
}

async function capabilities(
  url: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): Promise<Outcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_PROBE_TIMEOUT_MS);
  try {
    const res = await withAbort(
      fetchImpl(`${url}/api/auth/capabilities`, {
        ...(Object.keys(headers).length ? { redirect: "error" as const } : {}),
        headers: { ...headers, accept: "application/json", origin: "rakazo://" },
        signal: controller.signal,
      }),
      controller.signal,
      "Request timed out",
    );
    if (!res.ok) {
      cancelResponseBody(res);
      return "foreign";
    }
    const body = await readBoundedJsonResponse<unknown>(
      res,
      MAX_API_PROBE_RESPONSE_BYTES,
      controller.signal,
    );
    return authCapabilitiesSchema.safeParse(body).success ? "ok" : "foreign";
  } catch (error) {
    if (controller.signal.aborted) return "timeout";
    return error instanceof SyntaxError ? "foreign" : "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/** The same address with `www.` added or removed; none for an IP, a local name or a port. */
export function wwwAlternative(url: string): string | null {
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (parsed.port || !host.includes(".") || isPrivateNetworkHost(host) || /^[\d.]+$/.test(host))
    return null;
  const next = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  return next.includes(".") ? `${parsed.protocol}//${next}` : null;
}
