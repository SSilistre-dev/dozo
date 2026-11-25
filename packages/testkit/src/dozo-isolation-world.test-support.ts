// The isolation world built: five people, A's personal Space P and shared Space S, B's own Space,
// each seeded with one of every kind of thing, and what the app sends out while the world runs.
import { AsyncLocalStorage } from "node:async_hooks";
import { EmailEmulator } from "@rakazo/adapters";
import type {
  IsolationApp,
  IsolationHandles,
  IsolationRecords,
  IsolationWorld,
  Person,
} from "./dozo-isolation.test-support.js";
import { canary, person, rand, rpc, startIsolationApp } from "./dozo-isolation.test-support.js";
import { seedExtras, seedTarget } from "./dozo-isolation-seed.test-support.js";
import { asSystem } from "./system-db.js";

export async function joinWithInvite(
  world: { app: IsolationApp; handles: IsolationHandles },
  owner: Person,
  guest: Person,
  spaceId: string,
) {
  const link = await rpc<{ url: string }>(world, owner.cookie, "spaces/invites/create", {
    spaceId,
  });
  const token = new URL(link.url).pathname.split("/").pop() ?? "";
  await rpc(world, guest.cookie, "spaces/invites/accept", { token });
}

/**
 * The cookie of the world's request the app is answering (`anonymous` without one), kept in all
 * work that request starts, timers included.
 */
const inRequest = new AsyncLocalStorage<string>();

/** Runs `work` as the world's request with `cookie` would, so what it sends counts as that request's. */
export function asWorldRequest<T>(cookie: string | undefined, work: () => T): T {
  return inRequest.run(cookie ?? "anonymous", work);
}

/**
 * Every job, push notification and mail the app sends from now on while answering a request (or
 * in work a request started), recorded as text so a scan can tell whom and what each one names,
 * with the cookie of the request that started it. The app's own timers (its reconciler re-enqueues
 * expiry jobs for ringing calls) are not a request's doing and are left out; a timer a request set
 * (an expiry job the in-memory queue runs later) is that request's.
 */
function recordOutgoing(handles: IsolationHandles): IsolationRecords {
  const records: IsolationRecords = { jobs: [], notifications: [], mail: [] };
  const text = (args: unknown[]) =>
    JSON.stringify(args, (_key, value: unknown) =>
      typeof value === "bigint" ? String(value) : value,
    );
  const jobs = handles.jobs as unknown as Record<string, unknown>;
  for (const name of new Set([
    ...Object.keys(jobs),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(jobs) ?? {}),
  ])) {
    if (name === "constructor" || typeof jobs[name] !== "function") continue;
    if (!/^(enqueue|publish|add|wake|schedule)/i.test(name)) continue;
    const original = (jobs[name] as (...args: unknown[]) => unknown).bind(jobs);
    jobs[name] = (...args: unknown[]) => {
      const by = inRequest.getStore();
      // enqueueIn and enqueueManyIn take the transaction's database client first: not a job's words.
      const said = /In$/.test(name) ? args.slice(1) : args;
      if (by) records.jobs.push({ by, text: `${name} ${text(said)}` });
      return original(...args);
    };
  }
  const notifications = handles.notifications as unknown as Record<
    string,
    ((...args: unknown[]) => unknown) | undefined
  >;
  for (const name of ["send", "incomingCall"]) {
    const original = notifications[name]?.bind(notifications);
    if (!original) continue;
    notifications[name] = (...args: unknown[]) => {
      const first = args[0] as { userId?: string } | string | undefined;
      const userId = typeof first === "string" ? first : (first?.userId ?? "");
      const by = inRequest.getStore();
      if (by) records.notifications.push({ by, userId, text: text(args) });
      return original(...args);
    };
  }
  const mail = handles.email as unknown as
    | { send(message: { to?: unknown }): Promise<void> }
    | undefined;
  if (mail) {
    const original = mail.send.bind(mail);
    mail.send = (message) => {
      const by = inRequest.getStore();
      if (by) records.mail.push({ by, to: String(message.to ?? ""), text: text([message]) });
      return original(message);
    };
  }
  return records;
}

/**
 * `extended`: the matrix's world. Mail goes to an emulator and calls are on, every procedure's
 * id has something real to name (`seedExtras`), the owner's name and address are canaries, and
 * outgoing jobs, notifications and mail are recorded. The default world stays as it was.
 */
export async function buildIsolationWorld(
  databaseUrl?: string,
  options: { extended?: boolean } = {},
): Promise<IsolationWorld> {
  const extended = options.extended === true;
  const { handles, cleanup } = await startIsolationApp(
    databaseUrl,
    extended
      ? {
          email: new EmailEmulator(),
          phoneCallsEnabled: true,
          phoneCallRingSeconds: 24 * 60 * 60,
        }
      : {},
  );
  const app: IsolationApp = extended
    ? {
        request: (input, init) =>
          inRequest.run(new Headers(init?.headers).get("cookie") ?? "anonymous", () =>
            handles.app.request(input, init),
          ),
      }
    : handles.app;
  const db = asSystem(handles.prisma);
  const world = { app, handles, db };
  const stamp = `${Date.now()}-${rand()}`;
  const ownerName = extended ? canary("A", "ownername") : undefined;
  const A = await person(app, db, "A", stamp, ownerName);
  const B = await person(app, db, "B", stamp);
  const C = await person(app, db, "C", stamp);
  const D = await person(app, db, "D", stamp);
  const E = await person(app, db, "E", stamp);

  const shared = await rpc<{ id: string }>(world, A.cookie, "spaces/create", {
    name: "Iso shared",
  });
  // C joins A's organization the way the directory adds a member; the organization's trigger puts
  // a new member into its default Space, so A removes C from P through the real removal path.
  await db.member.create({
    data: {
      id: `iso-member-${stamp}`,
      organizationId: A.organizationId,
      userId: C.userId,
      role: "member",
      createdAt: new Date(),
    },
  });
  if (await db.spaceMember.findFirst({ where: { spaceId: A.spaceId, userId: C.userId } })) {
    await rpc(world, A.cookie, "spaces/members/remove", { spaceId: A.spaceId, userId: C.userId });
  }
  await joinWithInvite(world, A, C, shared.id);
  await joinWithInvite(world, A, D, shared.id);
  await joinWithInvite(world, A, E, shared.id);
  await rpc(world, A.cookie, "spaces/members/remove", { spaceId: shared.id, userId: E.userId });

  const P = await seedTarget(world, A, A.spaceId, "P", "A", A.userId, extended);
  const S = await seedTarget(world, A, shared.id, "S", "S", D.userId, extended);
  const Bown = await seedTarget(world, B, B.spaceId, "B", "B", B.userId, extended);
  if (!extended) return { handles, app, db, A, B, C, D, E, P, S, Bown, stop: cleanup };
  const solo = await rpc<{ id: string }>(world, A.cookie, "organizations/create", {
    name: canary("A", "soloorg").slice(0, 60),
  });
  await seedExtras(world, A, P, "A", solo.id);
  await seedExtras(world, A, S, "S", solo.id);
  const soloB = await rpc<{ id: string }>(world, B.cookie, "organizations/create", {
    name: canary("B", "soloorg").slice(0, 60),
  });
  await seedExtras(world, B, Bown, "B", soloB.id);
  for (const target of [P, S]) target.identityCanaries = [A.email, ownerName!];
  return {
    handles,
    app,
    db,
    A,
    B,
    C,
    D,
    E,
    P,
    S,
    Bown,
    records: recordOutgoing(handles),
    stop: cleanup,
  };
}
