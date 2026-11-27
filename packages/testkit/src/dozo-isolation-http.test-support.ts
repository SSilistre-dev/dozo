// HTTP helpers for the raw-route isolation test (dozo-isolation-http.postgres.test.ts): requests
// with their headers, streams read in the background, the app's raw routes and the generated
// requests that call them. The world, canaries and snapshot are the RPC matrix's support file.
import { expect } from "vitest";
import type { IsolationWorld, Target } from "./dozo-isolation.test-support.js";
import { findCanaries, rawRpc, STREAM_READ_MS } from "./dozo-isolation.test-support.js";

const CONCURRENCY = 8;

/** An answer: its status, body as text, and every response header as `name: value` lines. */
export type Answer = { status: number; text: string; headers: string };

/** Every header of a response, one `name: value` per line, so a scan sees names and values. */
export function headerText(response: Response): string {
  return [...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n");
}

/** A socket peer for the in-process request, so routes that limit per address can tell one. */
export const peer = (n: number) => ({
  incoming: {
    socket: { remoteAddress: `198.51.100.${n}`, remotePort: 40_000, remoteFamily: "IPv4" },
  },
});

/** The answer as text, read for at most `ms`: a stream is cut there, as a client hanging up. */
async function readBody(response: Response, ms: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const hangUp = AbortSignal.timeout(ms);
  const cancel = () => void reader.cancel();
  hangUp.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    hangUp.removeEventListener("abort", cancel);
  }
  return text;
}

export async function send(
  world: IsolationWorld,
  path: string,
  init: RequestInit = {},
  from = 1,
  ms = STREAM_READ_MS,
): Promise<Answer> {
  const controller = new AbortController();
  const response = await world.handles.app.request(
    path,
    { ...init, signal: controller.signal },
    peer(from),
  );
  const text = await readBody(response, ms);
  controller.abort();
  return { status: response.status, text, headers: headerText(response) };
}

export const json = (body: unknown) => ({
  "content-type": "application/json",
  body: JSON.stringify(body),
});

/**
 * What a foreign caller must not get: a canary of `scan` in the body or the headers, or one of
 * `ids` (the target's Space, organization, owner, bots and chats) in the headers. Ids are looked
 * for in headers only, since a body may echo the id the request itself named.
 */
export function foreignLeaks(answer: Answer, scan: readonly string[], ids: readonly string[]) {
  return [
    ...findCanaries(answer.text, scan).map((value) => `body ${value}`),
    ...findCanaries(answer.headers, scan).map((value) => `header ${value}`),
    ...ids.filter((value) => answer.headers.includes(value)).map((value) => `header id ${value}`),
  ];
}

/** The ids that name a target and its owner, which no foreign answer's headers may carry. */
export function targetIds(target: Target): string[] {
  const { ids } = target;
  return [
    target.spaceId,
    target.organizationId,
    ids.ownerUserId,
    ids.botId,
    ids.secondBotId,
    ids.threadId,
    ids.chatId,
    ids.runId,
  ].filter((value): value is string => Boolean(value));
}

export async function pool<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

/** A stream read in the background until it ends or is stopped. */
function follow(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const state = { text: "", endedAt: 0, frames: [] as { at: number; text: string }[] };
  const done = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const text = decoder.decode(next.value, { stream: true });
      state.text += text;
      state.frames.push({ at: Date.now(), text });
    }
    state.endedAt = Date.now();
  })();
  return {
    state,
    done,
    async stop() {
      await reader.cancel();
      await done;
    },
  };
}

export type OpenStream = Awaited<ReturnType<typeof openStream>>;

export async function openStream(
  world: IsolationWorld,
  cookie: string,
  procedure: string,
  input: unknown,
  spaceId: string,
) {
  const controller = new AbortController();
  const response = await rawRpc(world.app, cookie, procedure, input, spaceId, controller.signal);
  expect(response.status, `${procedure} opened`).toBe(200);
  const stream = follow(response);
  return {
    state: stream.state,
    headers: headerText(response),
    done: stream.done,
    async stop() {
      controller.abort();
      await stream.stop();
    },
  };
}

/**
 * The messages a stream carried, each `data:` line parsed as the RPC event iterator sends it
 * (`{"json": value}`), with when its chunk arrived. A line that is not JSON is kept as text.
 */
export function streamEvents(state: { frames: { at: number; text: string }[] }) {
  const events: { at: number; value: unknown }[] = [];
  let carry = "";
  for (const frame of state.frames) {
    const lines = (carry + frame.text).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      try {
        const parsed = JSON.parse(data) as { json?: unknown };
        events.push({ at: frame.at, value: parsed?.json ?? parsed });
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        events.push({ at: frame.at, value: data });
      }
    }
  }
  return events;
}

/** A stream event's `type`, or the event as text when it has none. */
export function eventType(value: unknown): string {
  if (value && typeof value === "object" && "type" in value) return String(value.type);
  return JSON.stringify(value);
}

// --- Routes --------------------------------------------------------------------------------------

type RouteEntry = { method: string; path: string; handler: { length: number } };

/**
 * The routes the app answers itself, as `METHOD /path`: middleware (a handler that takes `next`)
 * is left out, as Hono's own route inspector does, and so is `/rpc/*`, which the RPC matrix covers.
 */
export function rawRoutes(world: IsolationWorld): string[] {
  const routes = (world.handles.app as unknown as { routes: RouteEntry[] }).routes;
  return [
    ...new Set(
      routes
        .filter((route) => route.handler.length < 2 && !route.path.startsWith("/rpc/"))
        .map((route) => `${route.method} ${route.path}`),
    ),
  ].sort();
}

/**
 * Auth endpoints called one by one: the session, account and Space readers, and the ones that take
 * an id a foreign caller could swap in. `{org}`, `{account}` and `{session}` become the target's.
 */
export const AUTH_ENDPOINTS: {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, string>;
}[] = [
  { method: "GET", path: "/api/auth/get-session" },
  { method: "GET", path: "/api/auth/list-sessions" },
  { method: "GET", path: "/api/auth/list-accounts" },
  { method: "GET", path: "/api/auth/account-info?accountId={account}" },
  { method: "GET", path: "/api/auth/account-security" },
  { method: "GET", path: "/api/auth/passkey/list-user-passkeys" },
  { method: "GET", path: "/api/auth/organization/list" },
  { method: "GET", path: "/api/auth/organization/get-full-organization?organizationId={org}" },
  { method: "GET", path: "/api/auth/organization/list-members?organizationId={org}" },
  { method: "GET", path: "/api/auth/organization/get-active-member" },
  { method: "GET", path: "/api/auth/dozo/email-link?v={account}" },
  { method: "GET", path: "/api/auth/dozo/hosted-login/keys" },
  { method: "POST", path: "/api/auth/organization/set-active", body: { organizationId: "{org}" } },
  {
    method: "POST",
    path: "/api/auth/organization/remove-member",
    body: { memberIdOrEmail: "{owner}", organizationId: "{org}" },
  },
  {
    method: "POST",
    path: "/api/auth/unlink-account",
    body: { providerId: "credential", accountId: "{account}" },
  },
  { method: "POST", path: "/api/auth/revoke-session", body: { token: "{session}" } },
  { method: "POST", path: "/api/auth/passkey/delete-passkey", body: { id: "{account}" } },
  { method: "POST", path: "/api/auth/request-identity-code" },
];

export type HttpCaller = { name: string; headers: Record<string, string>; from: number };
export type TargetIds = Target["ids"] & {
  deviceId?: string;
  accountId?: string;
  session?: string;
  taskId?: string;
};
export type HttpRequest = { route: string; method: string; url: string; body?: string };

/** One request per method a route answers, every id in it the target's. */
export function requestsFor(route: string, ids: TargetIds): HttpRequest[] {
  const [method = "", path = ""] = route.split(" ");
  const param: Record<string, string | undefined> = {
    botId: ids.botId,
    runId: ids.runId,
    deviceId: ids.deviceId,
    id: ids.taskId,
    token: ids.pageId,
    file: ids.artifactId,
    surface: "web",
    provider: "fake",
  };
  const url = path
    .replace(/:(\w+)/g, (_match, name: string) => param[name] ?? ids.botId ?? "x")
    .replace(/\*/g, ids.botId ?? "x");
  const query = new URLSearchParams({
    botId: ids.botId ?? "",
    chat: ids.chatId ?? "",
    chatId: ids.chatId ?? "",
    spaceId: ids.spaceId ?? "",
    organizationId: ids.organizationId ?? "",
    token: ids.pageId ?? "",
    after: "-1",
  });
  const body = JSON.stringify({
    botId: ids.botId,
    chatId: ids.chatId,
    threadId: ids.threadId,
    runId: ids.runId,
    spaceId: ids.spaceId,
    organizationId: ids.organizationId,
    userId: ids.ownerUserId,
    deviceId: ids.deviceId,
    artifactId: ids.artifactId,
    text: "iso-probe",
  });
  const methods = method === "ALL" ? ["GET", "POST"] : [method];
  return methods.map((each) => ({
    route,
    method: each,
    url: `${url}?${query}`,
    ...(each === "GET" || each === "HEAD" ? {} : { body }),
  }));
}

export function authRequests(ids: TargetIds): HttpRequest[] {
  const fill = (text: string) =>
    text
      .replace("{org}", ids.organizationId ?? "")
      .replace("{account}", ids.accountId ?? "")
      .replace("{owner}", ids.ownerUserId ?? "")
      .replace("{session}", ids.session ?? "");
  return AUTH_ENDPOINTS.map((endpoint) => ({
    route: `${endpoint.method} ${endpoint.path.split("?")[0]}`,
    method: endpoint.method,
    url: fill(endpoint.path),
    ...(endpoint.method === "POST" ? { body: fill(JSON.stringify(endpoint.body ?? {})) } : {}),
  }));
}

/** Sends one generated request as `caller`, as every caller of the route sweep sends it. */
export function sendRequest(world: IsolationWorld, caller: HttpCaller, request: HttpRequest) {
  return send(
    world,
    request.url,
    {
      method: request.method,
      headers: { ...caller.headers, ...(request.body ? json({}) : {}), "last-event-id": "-1" },
      ...(request.body ? { body: request.body } : {}),
    },
    caller.from,
  );
}

/** What an answer looks like without its values: status and the JSON's keys and value types. */
export function shape(answer: { status: number; text: string }): string {
  const outline = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(outline);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, outline(item)]),
      );
    return typeof value;
  };
  let body: unknown = answer.text;
  try {
    body = outline(JSON.parse(answer.text));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return JSON.stringify({ status: answer.status, body });
}
