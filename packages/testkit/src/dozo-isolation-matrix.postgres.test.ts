// Cross-tenant isolation over the whole RPC surface. Every procedure of the contract is called by
// every caller that must not reach P (A's personal Space) or S (A's shared Space), with inputs
// that name P's or S's things; no answer may carry one of their canaries, and nothing P or S
// holds may change. A new procedure is swept by itself: the list is read from the contract.
// Inputs: dozo-isolation-inputs.test-support.ts; the sweep and its reports:
// dozo-isolation-sweep.test-support.ts.
import { callRequestClientNonce } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IsolationApp, IsolationWorld, Target } from "./dozo-isolation.test-support.js";
import { findCanaries, ISOLATION_LOGINS, readAnswer } from "./dozo-isolation.test-support.js";
import type { IsolationExemption } from "./dozo-isolation-exemptions.js";
import { ISOLATION_EXEMPTIONS } from "./dozo-isolation-exemptions.js";
import type { Procedure } from "./dozo-isolation-inputs.test-support.js";
import {
  contractProcedures,
  generateInputs,
  idFields,
  namesKey,
  namesTarget,
} from "./dozo-isolation-inputs.test-support.js";
import { releaseWaitingRun, seedWaitingRun } from "./dozo-isolation-seed.test-support.js";
import { DESIGNED_SHARING, DESIGNED_SHARING_SOMETIMES } from "./dozo-isolation-sharing.js";
import { snapshot, snapshotDiff } from "./dozo-isolation-snapshot.test-support.js";
import type { Call, Caller, Outcome } from "./dozo-isolation-sweep.test-support.js";
import {
  codeReferenceProblem,
  failures,
  foreignIds,
  isDestructive,
  kindOf,
  line,
  mark,
  notable,
  outgoingReport,
  reaches,
  reachReport,
  refusalReport,
  summary,
  sweep,
  waitingRunKept,
} from "./dozo-isolation-sweep.test-support.js";
import { asWorldRequest, buildIsolationWorld } from "./dozo-isolation-world.test-support.js";

/** A failure's label with what it found, one a line: the CI log shows the message, not the list. */
const named = (label: string, items: readonly string[]) => `${label}\n${items.join("\n")}`;

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

/** The designed sharing pairs a member or guest of S was shown, over the passes of both logins. */
const designedSeen = new Map<string, Set<string>>();

/** Procedures the owner must see P's canaries through: reads of every kind planted, one streamed. */
const CONTROL_PATHS = ["threads/messages", "threads/subscribe", "bots/get", "artifacts/getById"];

/** Procedures that only read, by the last word of their path; the owner's control reads them first. */
const READ =
  /^(get|list|messages|head|subscribe|status|pins|query|export|markdown|csv|breakdown|summary|items|events|history|budget|snapshot|revisable|routineChat|getById|bot|comments|preview|files|readFile)/i;

/**
 * Writes the owner's control makes first, as its other writes change what they need: the Space's
 * whole roster (its creates grow it) and the live recording (its computer calls end it).
 */
const OWNER_WRITES_FIRST = new Set(["bots/reorder", "skills/appendEvent"]);

/**
 * Removals the owner's control makes last, in this order: everything else hangs off what they
 * remove, so a removal made earlier would answer the rest "not found" for the owner too.
 */
const OWNER_REMOVES_LAST = [
  "messaging/identities/unlink",
  "threads/clear",
  "dozoChats/archive",
  "groups/archive",
  "groups/remove",
  "bots/archive",
  "bots/remove",
];

/** Tables a member's or guest's calls in S must leave as they were: who is in S, and A's keys. */
const ADMIN_TABLES =
  /^(space|spaceMember|member|organization|secret|agentSecret|vaultCredential|userModelCredential|billingAccount|sql:dozo_access_tokens)$/;

describeWithDatabase.each(ISOLATION_LOGINS)(
  "cross-tenant isolation over every RPC procedure ($name)",
  (login) => {
    let world: IsolationWorld;
    const procedures = contractProcedures();
    const exempt = new Map(
      ISOLATION_EXEMPTIONS.filter(
        (item) => item.kind === "input" || item.kind === "side-effect",
      ).map((item) => [item.path, item]),
    );
    const noTarget = new Map(
      ISOLATION_EXEMPTIONS.filter((item) => item.kind === "no-target").map((item) => [
        item.path,
        item,
      ]),
    );
    const swept = () => procedures.filter((procedure) => !exempt.has(procedure.path));
    const scopeOf = (...targets: Target[]) => ({
      spaceIds: targets.map((target) => target.spaceId),
      organizationIds: [
        ...new Set(
          targets.flatMap((target) => [
            target.organizationId,
            ...(target.ids.soloOrganizationId ? [target.ids.soloOrganizationId] : []),
          ]),
        ),
      ],
      userIds: [world.A.userId],
    });
    const prefix = `[isolation ${login.name}]`;

    beforeAll(async () => {
      world = await buildIsolationWorld(login.url(), { extended: true });
    }, 240_000);

    afterAll(async () => {
      await world?.stop();
    });

    it("plants canaries the designed readers see (the matrix is not vacuous)", async () => {
      const { A, C, D, E, P, S } = world;
      expect(findCanaries(`x ${P.canaries[0]} y`, P.canaries)).toEqual([P.canaries[0]]);
      for (const lead of ["", "a", "ab"])
        expect(
          findCanaries(Buffer.from(`${lead}${P.canaries[0]}\n`).toString("base64"), P.canaries),
        ).toEqual([P.canaries[0]]);
      const own = await readAnswer(
        world.app,
        A.cookie,
        "threads/messages",
        { botId: P.ids.botId },
        P.spaceId,
      );
      expect(own.status).toBe(200);
      expect(findCanaries(own.text, P.canaries).length).toBeGreaterThan(0);
      // Names the owner's later control sweep may rename: read them while they are as planted.
      for (const [procedure, input] of [
        ["bots/list", undefined],
        ["groups/get", { groupId: P.ids.groupId }],
        ["agentSkills/list", undefined],
      ] as const) {
        const answer = await readAnswer(world.app, A.cookie, procedure, input, P.spaceId);
        expect(
          findCanaries(answer.text, P.canaries).length,
          `${procedure}: ${answer.text.slice(0, 300)}`,
        ).toBeGreaterThan(0);
      }
      const me = await readAnswer(world.app, A.cookie, "me", undefined, P.spaceId);
      expect(findCanaries(me.text, P.identityCanaries ?? []).length).toBe(2);
      for (const member of [C, D]) {
        const shared = await readAnswer(
          world.app,
          member.cookie,
          "threads/messages",
          { botId: S.ids.botId },
          S.spaceId,
        );
        expect(shared.status, member.label).toBe(200);
        expect(findCanaries(shared.text, S.canaries).length, member.label).toBeGreaterThan(0);
      }
      expect((await readAnswer(world.app, E.cookie, "me", undefined, S.spaceId)).status).toBe(401);
      expect((await readAnswer(world.app, C.cookie, "me", undefined, P.spaceId)).status).toBe(401);
      console.log(`${prefix} seed notes:\n${[...P.notes, ...S.notes].join("\n")}`);
      const unseeded = [...P.notes, ...S.notes, ...world.Bown.notes].filter((note) =>
        note.includes("could not be seeded"),
      );
      expect(unseeded, "seeds that failed").toEqual([]);
    });

    it("reads every procedure from the contract and fills every id it names from the target", () => {
      const paths = new Set(procedures.map((procedure) => procedure.path));
      expect(procedures.length).toBeGreaterThan(300);
      const ids = world.P.ids;
      const missing: string[] = [];
      const stale: string[] = [];
      const unfilled: string[] = [];
      let foreign = 0;
      for (const procedure of procedures) {
        const inputs = generateInputs(procedure, (key) => ids[key]);
        const exemption = exempt.get(procedure.path);
        if (!exemption && !inputs) missing.push(procedure.path);
        if (exemption?.kind === "input" && inputs)
          stale.push(`${procedure.path}: input can be generated now`);
        if (exemption?.kind === "side-effect" && inputs?.some((variant) => variant.keys.size > 0))
          stale.push(`${procedure.path}: names a target, so it must be swept`);
        if (exemption) continue;
        if (inputs?.some((variant) => variant.keys.size > 0)) foreign++;
        // Every field that names something gets one of P's things, or says why it cannot.
        const fields = idFields(procedure.input);
        const filled = new Set((inputs ?? []).flatMap((variant) => [...(variant.filled ?? [])]));
        const allowed = noTarget.get(procedure.path)?.fields ?? [];
        for (const field of fields)
          if (!filled.has(field) && !allowed.includes(field))
            unfilled.push(`${procedure.path}: ${field}`);
        for (const field of allowed) {
          if (!fields.has(field)) stale.push(`${procedure.path}: no field ${field} (no-target)`);
          else if (filled.has(field))
            stale.push(`${procedure.path}: ${field} is filled from the target now (no-target)`);
        }
      }
      const problems: string[] = [];
      for (const exemption of ISOLATION_EXEMPTIONS) {
        if (!paths.has(exemption.path)) stale.push(`${exemption.path}: no such procedure`);
        if (
          ["unreached", "no-target", "reached-409", "distinguishable"].includes(exemption.kind) &&
          exempt.has(exemption.path)
        )
          stale.push(`${exemption.path}: ${exemption.kind}, yet not swept`);
        if (exemption.kind === "no-target" && !exemption.fields?.length)
          problems.push(`${exemption.path}: no-target names no field`);
        if (exemption.kind === "unreached") {
          const problem = codeReferenceProblem(exemption.verifiedByCode);
          if (problem) problems.push(`${exemption.path}: verifiedByCode ${problem}`);
        }
      }
      const count = (kind: IsolationExemption["kind"]) =>
        ISOLATION_EXEMPTIONS.filter((item) => item.kind === kind).length;
      console.log(
        `${prefix} procedures enumerated ${procedures.length}, swept ${swept().length}, naming a target ${foreign}, exemptions: input ${count("input")}, side-effect ${count("side-effect")}, unreached ${count("unreached")}, no-target ${count("no-target")}, reached-409 ${count("reached-409")}, distinguishable ${count("distinguishable")}`,
      );
      expect(missing, "procedures with no generated input and no exemption").toEqual([]);
      expect(unfilled, "id fields no target thing fills and no no-target entry explains").toEqual(
        [],
      );
      expect(problems, "exemptions without their proof").toEqual([]);
      expect(stale, "stale exemptions").toEqual([]);
    });

    it("turns red on each kind of leak it is meant to catch (self-test)", async () => {
      const { A, B, P, Bown } = world;
      const shape = procedures.find((procedure) => procedure.path === "bots/get")!.input;
      const kinds = [
        "read-leak",
        "write-mixing",
        "header-leak",
        "foreign-id",
        "distinguishable",
        "side-effect",
        "stream-leak",
      ];
      const fakes: Procedure[] = kinds.map((kind) => ({
        path: `isoSelfTest/${kind}`,
        input: shape,
      }));
      const original = await world.db.bot.findUniqueOrThrow({
        where: { id: P.ids.botId! },
        select: { description: true },
      });
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        });
      // A live stream that opens with a heartbeat and sends one of P's canaries on the next read.
      const streamLeak = (signal?: AbortSignal) => {
        const encoder = new TextEncoder();
        const frames = [{ type: "heartbeat" }, { type: "alert", alert: { title: P.canaries[2] } }];
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = frames.shift();
            if (next) {
              controller.enqueue(
                encoder.encode(`event: message\ndata: ${JSON.stringify({ json: next })}\n\n`),
              );
              return;
            }
            // Open until the reader hangs up, as a live stream is.
            if (!signal?.aborted)
              await new Promise<void>((resolve) =>
                signal?.addEventListener("abort", () => resolve(), { once: true }),
              );
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };
      // Each fake handler leaks one way; everything else goes to the real app.
      const app: IsolationApp = {
        request: async (input, init) => {
          const kind = /\/rpc\/isoSelfTest\/(.+)$/.exec(input)?.[1];
          if (!kind) return world.app.request(input, init);
          const body = JSON.parse(String(init?.body ?? "{}")) as { json?: { botId?: string } };
          const existing = body.json?.botId === P.ids.botId;
          switch (kind) {
            case "read-leak":
              return json({ json: { name: P.canaries[0] } });
            case "write-mixing":
              if (existing)
                await world.db.bot.update({
                  where: { id: P.ids.botId! },
                  data: { description: "iso-self-test-mixed" },
                });
              return json({ json: { ok: true } });
            case "header-leak":
              return json({ json: { code: "NOT_FOUND" } }, 404, {
                "content-disposition": `attachment; filename="${P.canaries[1]}"`,
              });
            case "foreign-id":
              return json({ json: { code: "NOT_FOUND", message: `see ${P.ids.threadId}` } }, 404);
            case "side-effect":
              // Refused like any foreign id, but mails A about P's bot while answering.
              if (existing)
                await asWorldRequest(new Headers(init?.headers).get("cookie") ?? undefined, () =>
                  world.handles.email!.send({
                    to: A.email,
                    subject: "iso-self-test",
                    text: `about ${P.ids.botId}`,
                  }),
                );
              return json({ json: { code: "NOT_FOUND" } }, 404);
            case "stream-leak":
              return streamLeak(init?.signal ?? undefined);
            default:
              return existing
                ? json({ json: { code: "NOT_FOUND" } }, 404)
                : json({ json: { code: "BAD_REQUEST" } }, 400);
          }
        },
      };
      const caller: Caller = {
        name: "B (self-test)",
        cookie: B.cookie,
        spaceId: B.spaceId,
        target: P,
        own: Bown,
        expect: "no-canary",
        compare: true,
      };
      const before = await snapshot(world.db, scopeOf(P));
      const from = mark(world.records!);
      const outcomes = await sweep(app, [caller], fakes);
      const outgoing = outgoingReport(world.records!, from, [caller], A, [P.ids.botId!]);
      const diff = snapshotDiff(before, await snapshot(world.db, scopeOf(P)));
      await world.db.bot.update({
        where: { id: P.ids.botId! },
        data: { description: original.description },
      });
      const red = [...failures(outcomes), ...refusalReport(outcomes, []).fresh];
      const caught = (kind: string) => red.some((item) => item.startsWith(`isoSelfTest/${kind}`));
      expect(caught("read-leak"), red.join("\n")).toBe(true);
      expect(caught("header-leak"), red.join("\n")).toBe(true);
      expect(caught("foreign-id"), red.join("\n")).toBe(true);
      expect(caught("distinguishable"), red.join("\n")).toBe(true);
      expect(caught("stream-leak"), red.join("\n")).toBe(true);
      expect(
        outcomes.some((outcome) => outcome.path === "isoSelfTest/stream-leak" && outcome.streamed),
      ).toBe(true);
      expect(
        outgoing.some((item) => item.includes("iso-self-test")),
        outgoing.join("\n"),
      ).toBe(true);
      expect(
        diff.some((item) => item.startsWith("bot:")),
        diff.join("\n"),
      ).toBe(true);
      // Fakes that leak no answer stay green there, so the ones above are red for their leak only:
      // the write shows in the snapshot, the mail in what the app sent.
      expect(red.filter((item) => item.startsWith("isoSelfTest/write-mixing"))).toEqual([]);
      expect(red.filter((item) => item.startsWith("isoSelfTest/side-effect"))).toEqual([]);
    });

    it("keeps P and S from B, a removed member, anonymous callers and foreign Space headers", async () => {
      const { A, B, C, D, E, P, S, Bown } = world;
      const callers: Caller[] = [
        {
          name: "B on own Space, P ids",
          cookie: B.cookie,
          spaceId: B.spaceId,
          target: P,
          own: Bown,
          expect: "no-canary",
          compare: true,
        },
        {
          name: "B on own Space, S ids",
          cookie: B.cookie,
          spaceId: B.spaceId,
          target: S,
          own: Bown,
          expect: "no-canary",
          compare: true,
        },
        {
          name: "E (removed) on S",
          cookie: E.cookie,
          spaceId: S.spaceId,
          target: S,
          expect: "refused",
        },
        { name: "anonymous, P ids", spaceId: P.spaceId, target: P, expect: "refused" },
        {
          name: "B with P's header",
          cookie: B.cookie,
          spaceId: P.spaceId,
          target: P,
          expect: "refused",
        },
        {
          name: "B with S's header",
          cookie: B.cookie,
          spaceId: S.spaceId,
          target: S,
          expect: "refused",
        },
        {
          name: "C with P's header",
          cookie: C.cookie,
          spaceId: P.spaceId,
          target: P,
          expect: "refused",
          knowsOwner: true,
        },
        {
          name: "D with P's header",
          cookie: D.cookie,
          spaceId: P.spaceId,
          target: P,
          expect: "refused",
          knowsOwner: true,
        },
      ];
      const records = world.records!;
      expect(await waitingRunKept(world, [B.cookie], P, B.spaceId)).toEqual([]);
      expect(await waitingRunKept(world, [B.cookie], S, B.spaceId)).toEqual([]);
      const from = mark(records);
      const before = await snapshot(world.db, scopeOf(P, S));
      const outcomes = await sweep(world.app, callers, swept());
      console.log(
        `${prefix} statuses per caller\n${summary(outcomes)}\n${prefix} notable\n${notable(outcomes)}`,
      );
      // The read pass again, after every write: what B's mixed writes left in B's own world must not
      // bring P's or S's canaries back with it.
      const again = await sweep(
        world.app,
        callers.slice(0, 2),
        swept().filter((procedure) => !isDestructive(procedure.path)),
        { ownToo: true, noIdScan: true },
      );
      const after = await snapshot(world.db, scopeOf(P, S));
      const refusals = refusalReport(outcomes);
      console.log(
        `${prefix} answers that tell an existing foreign id from a missing one\n${refusals.all.join("\n")}`,
      );
      const needles = [A.userId, A.email, ...foreignIds(callers[0]!), ...foreignIds(callers[1]!)];
      expect([...failures(outcomes), ...failures(again)]).toEqual([]);
      expect(refusals.fresh, "distinguishable refusals not listed as known").toEqual([]);
      expect(refusals.stale, "known distinguishable refusals that no longer differ").toEqual([]);
      expect(snapshotDiff(before, after), `rows of P or S changed (A is ${A.userId})`).toEqual([]);
      expect(
        outgoingReport(records, from, callers, A, needles),
        "jobs, notifications or mail for A, P or S",
      ).toEqual([]);
    }, 900_000);

    it("keeps P from S's guest and S's organization member", async () => {
      const { C, D, P, S } = world;
      const callers: Caller[] = [
        {
          name: "D (guest) on S, P ids",
          cookie: D.cookie,
          spaceId: S.spaceId,
          target: P,
          own: S,
          expect: "no-canary",
          knowsOwner: true,
        },
        {
          name: "C (org member) on S, P ids",
          cookie: C.cookie,
          spaceId: S.spaceId,
          target: P,
          own: S,
          expect: "no-canary",
          knowsOwner: true,
        },
      ];
      // P's rows only: C is a member of A's organization by design, so a Space C makes from S
      // lands in that organization and is C's own, not P's.
      const scope = { ...scopeOf(P), organizationIds: [P.ids.soloOrganizationId!] };
      const records = world.records!;
      expect(await waitingRunKept(world, [C.cookie, D.cookie], P, S.spaceId)).toEqual([]);
      const from = mark(records);
      const before = await snapshot(world.db, scope);
      const outcomes = await sweep(world.app, callers, swept());
      console.log(
        `${prefix} statuses per caller\n${summary(outcomes)}\n${prefix} notable\n${notable(outcomes)}`,
      );
      const after = await snapshot(world.db, scope);
      expect(failures(outcomes)).toEqual([]);
      expect(snapshotDiff(before, after).join("\n"), "rows of P changed").toBe("");
      // A guest's new Space goes to the guest's own organization, never into A's.
      expect(
        await world.db.space.count({
          where: { organizationId: P.organizationId, createdByUserId: D.userId },
        }),
      ).toBe(0);
      // What C and D do in S may name S by design; nothing may name what only P holds.
      const shared = new Set(Object.values(S.ids));
      const onlyP = foreignIds(callers[0]!).filter((value) => !shared.has(value));
      expect(
        outgoingReport(records, from, callers, { userId: "-", email: "-" }, onlyP),
        "jobs, notifications or mail naming P",
      ).toEqual([]);
    }, 900_000);

    it("shows S's member and guest only what S shares by design", async () => {
      const { A, C, D, S } = world;
      const callers: Caller[] = [C, D].map((person) => ({
        name: `${person.label} on S, S ids`,
        cookie: person.cookie,
        spaceId: S.spaceId,
        target: S,
        expect: "shared",
        knowsOwner: true,
      }));
      const scope = {
        spaceIds: [S.spaceId],
        organizationIds: [S.organizationId],
        userIds: [A.userId],
      };
      const before = await snapshot(world.db, scope);
      // The caller's own leave is theirs by design, and would end the rest of its sweep.
      const calls: string[] = [];
      // Read before the removals: a member may clear S's chat by design, and the cards with it.
      const callsChecked = async (): Promise<Outcome[]> => {
        // A call rings the owner's own phone: the card shows in the shared chat by design, but a
        // member or guest must not answer, decline or end it for A.
        for (const key of ["callId", "declineCallId", "incomingCallId"] as const) {
          const message = await world.db.message.findUnique({
            where: {
              threadId_clientNonce: {
                threadId: S.ids.threadId!,
                clientNonce: callRequestClientNonce(S.ids[key]!),
              },
            },
            select: { blocks: true },
          });
          const status = /"status":"(\w+)"/.exec(JSON.stringify(message?.blocks ?? null))?.[1];
          if (status !== "ringing") calls.push(`${key}: ${status ?? "gone"}`);
        }
        return [];
      };
      // Removals the rest hang off (a bot, a chat, a group) go last, one at a time, so a member's
      // removal of S's bot does not answer the other destructive calls "not found".
      const procedures = swept().filter((procedure) => procedure.path !== "spaces/members/leave");
      const last = (procedure: Procedure) => OWNER_REMOVES_LAST.includes(procedure.path);
      const outcomes = [
        ...(await sweep(
          world.app,
          callers,
          procedures.filter((procedure) => !last(procedure)),
        )),
        ...(await callsChecked()),
        ...(await sweep(
          world.app,
          callers,
          procedures
            .filter(last)
            .sort(
              (a, b) => OWNER_REMOVES_LAST.indexOf(a.path) - OWNER_REMOVES_LAST.indexOf(b.path),
            ),
          { concurrency: 1 },
        )),
      ];
      const after = await snapshot(world.db, scope);
      const seen = new Map<string, Set<string>>();
      for (const outcome of outcomes)
        for (const value of outcome.matched) {
          const kinds = seen.get(outcome.path) ?? new Set<string>();
          kinds.add(kindOf(S, value));
          seen.set(outcome.path, kinds);
        }
      for (const [path, kinds] of seen) {
        const all = designedSeen.get(path) ?? new Set<string>();
        for (const kind of kinds) all.add(kind);
        designedSeen.set(path, all);
      }
      console.log(
        `${prefix} S canaries a member or guest sees, by procedure\n${[...seen]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([procedure, kinds]) => `${procedure}: ${[...kinds].sort().join(" ")}`)
          .join("\n")}`,
      );
      // What C or D added as their own (a Space C makes in the organization it is a member of, a
      // token of C's own) is theirs by design; any other change to these tables is not.
      const admin: string[] = [];
      for (const [table, rows] of after) {
        if (!ADMIN_TABLES.test(table)) continue;
        const old = before.get(table) ?? new Map<string, string>();
        for (const [key, text] of rows) {
          if (!old.has(key)) {
            if (![C.userId, D.userId].some((id) => text.includes(id)))
              admin.push(`${table}: added ${text.slice(0, 300)}`);
          } else if (old.get(key) !== text) admin.push(`${table}: changed ${text.slice(0, 300)}`);
        }
        for (const key of old.keys())
          if (!rows.has(key)) admin.push(`${table}: removed ${old.get(key)!.slice(0, 300)}`);
      }
      console.log(
        `${prefix} call procedures as a member or guest of S\n${outcomes
          .filter((outcome) => /Call$/.test(outcome.path))
          .map((outcome) => `${outcome.caller.name}: ${line(outcome)}`)
          .join("\n")}`,
      );
      const shown = failures(outcomes);
      expect(shown, named("seen by a member or guest outside the design", shown)).toEqual([]);
      expect(admin, "a member or guest changed who is in S, or A's keys").toEqual([]);
      expect(calls, "the owner's ringing calls in S, settled by a member or guest").toEqual([]);
      // A member may edit a memory document by design; the sweep's edit must land on a document of
      // its own, or `memory/exportMarkdown` and `memory/list` show the canary only if they read
      // before that edit.
      const memory = await world.db.memoryDocument.findUniqueOrThrow({
        where: { id: S.ids.documentId! },
      });
      expect(
        S.canaries.filter(
          (value) => S.kinds?.[value] === "memory" && memory.content.includes(value),
        ),
        "S's memory document, after a member's and guest's sweep",
      ).toHaveLength(1);
      expect(
        await world.db.spaceMember.count({ where: { spaceId: S.spaceId, userId: A.userId } }),
      ).toBe(1);
    }, 900_000);

    // Last, because the owner's own calls change P: the same sweep run by A finds P's canaries, so
    // the callers above found none because none reached them, not because the scan cannot see.
    it("finds P's canaries when its owner makes the same calls", async () => {
      const { A, P } = world;
      const owner: Caller = {
        name: "A on P (control)",
        cookie: A.cookie,
        spaceId: P.spaceId,
        target: P,
        expect: "no-canary",
        knowsOwner: true,
      };
      // The owner's computer starts and stops in the background: a call to it waits until it is
      // not halfway, so whether it gets through does not depend on timing.
      const computerState = async () =>
        (
          await world.db.bot.findUnique({
            where: { id: P.ids.botId! },
            select: { computer: { select: { state: true } } },
          })
        )?.computer?.state ?? "";
      // Typing, uploading and a terminal need the person to hold the computer, as in the app.
      const needsControl = [
        "computer/input",
        "computer/uploadFile",
        "computer/terminalUrl",
        "dozoTeach/keys",
      ];
      const settle = async (call: Call) => {
        if (!call.path.startsWith("computer/") && !needsControl.includes(call.path)) return;
        const steady = async () => {
          const state = await computerState();
          if (["booting", "suspending"].includes(state)) throw new Error(`computer ${state}`);
          return state;
        };
        const state = await vi.waitFor(steady, { timeout: 15_000, interval: 50 });
        // A computer call that is not a stop works on a running computer, as a person's does:
        // one the owner's sweep let fall asleep is started first (not part of the sweep).
        if (isDestructive(call.path)) return;
        if (state !== "running") {
          await readAnswer(world.app, A.cookie, "computer/boot", { botId: P.ids.botId }, P.spaceId);
          await vi.waitFor(
            async () => {
              if ((await steady()) !== "running") throw new Error("computer not running");
            },
            { timeout: 15_000, interval: 50 },
          );
        }
        if (needsControl.includes(call.path))
          await readAnswer(
            world.app,
            A.cookie,
            "computer/takeover",
            { botId: P.ids.botId },
            P.spaceId,
          );
      };
      const firstOf = (procedure: Procedure) => Number(OWNER_WRITES_FIRST.has(procedure.path));
      // Reads before the owner's own writes (an update renames, a new version replaces), so what is
      // planted is still there when it is read.
      const kept = swept().filter((procedure) => !isDestructive(procedure.path));
      const isRead = (procedure: Procedure) => READ.test(procedure.path.split("/").pop() ?? "");
      // The live recording holds the bot: the calls that act on it go first, then the owner stops
      // it, as the app does, and the rest of the bot's calls stop answering "stop teaching first".
      const teaching = (procedure: Procedure) =>
        OWNER_WRITES_FIRST.has(procedure.path) ||
        procedure.path === "skills/start" ||
        namesKey(procedure, P, "taughtSkillId") ||
        namesKey(procedure, P, "leaseId");
      const writes = kept.filter((procedure) => !isRead(procedure));
      // Taking control comes before the computer calls that need it (typing, a terminal).
      const computerFirst = (procedure: Procedure) =>
        procedure.path === "computer/takeover" ? 0 : procedure.path.startsWith("computer/") ? 1 : 2;
      // The owner's own `skills/start` began another recording: end it too, as a person does
      // before the chat takes messages again. Not part of the sweep, so it returns no outcomes.
      const stopRecordings = async (): Promise<Outcome[]> => {
        for (const skill of await world.db.taughtSkill.findMany({
          where: { botId: P.ids.botId!, status: "recording" },
          select: { id: true },
        }))
          await readAnswer(world.app, A.cookie, "skills/stop", { skillId: skill.id }, P.spaceId);
        return [];
      };
      const stop = swept().filter((procedure) => procedure.path === "skills/stop");
      const outcomes = [
        ...(await sweep(world.app, [owner], kept.filter(isRead))),
        ...(await sweep(
          world.app,
          [owner],
          writes.filter(teaching).sort((a, b) => firstOf(b) - firstOf(a)),
          { concurrency: 1, settle },
        )),
        ...(await sweep(world.app, [owner], stop, { concurrency: 1, settle })),
        ...(await stopRecordings()),
        ...(await sweep(
          world.app,
          [owner],
          writes
            .filter((procedure) => !teaching(procedure))
            .sort((a, b) => computerFirst(a) - computerFirst(b)),
          { concurrency: 1, settle },
        )),
      ];
      const found = [
        ...new Set(
          outcomes.filter((outcome) => outcome.matched.length).map((outcome) => outcome.path),
        ),
      ].sort();
      console.log(
        `${prefix} control: canaries found through ${found.length} procedures\n${found.join(" ")}`,
      );
      const seen = new Set(outcomes.flatMap((outcome) => outcome.matched));
      // The file a message carries is an artifact of its own, and the sweep's inputs name the
      // other one: the owner reads this one by its id, so its body is a canary a scan can find.
      const attached = await readAnswer(
        world.app,
        A.cookie,
        "artifacts/getById",
        { artifactId: P.ids.attachmentArtifactId },
        P.spaceId,
      );
      for (const value of findCanaries(attached.text, P.canaries)) seen.add(value);
      const unseen = P.canaries.filter((value) => !seen.has(value));
      console.log(`${prefix} control: canaries no owner read shows: ${unseen.join(" ") || "none"}`);
      // Destructive procedures that name P's things after that, one at a time, the removals the
      // rest hang off last; the waiting work made fresh first, as the app may have started it.
      await seedWaitingRun(world.db, A, P);
      const order = (procedure: Procedure) => OWNER_REMOVES_LAST.indexOf(procedure.path);
      outcomes.push(
        ...(await sweep(
          world.app,
          [owner],
          swept()
            .filter(
              (procedure) =>
                isDestructive(procedure.path) &&
                procedure.path !== "skills/stop" &&
                namesTarget(procedure, P),
            )
            .sort((a, b) => order(a) - order(b)),
          { concurrency: 1, settle },
        )),
      );
      const { unreached, stale, reached } = reachReport(outcomes);
      console.log(
        `${prefix} control: owner calls not reached, exempted\n${outcomes
          .filter((outcome) => outcome.foreign && !reaches(outcome))
          .map(line)
          .join("\n")}`,
      );
      const naming = new Set(
        outcomes.filter((outcome) => outcome.foreign).map((outcome) => outcome.path),
      );
      console.log(
        `${prefix} control: procedures naming P ${naming.size}, owner-reached ${reached.size}, not reached ${naming.size - reached.size}`,
      );
      await releaseWaitingRun(world.db, P);
      expect(found).toEqual(expect.arrayContaining(CONTROL_PATHS));
      expect(unseen, "canaries no read of the owner shows, so no scan can find them").toEqual([]);
      expect
        .soft(
          unreached,
          named(
            "inputs naming P's things that the owner's own call does not get through",
            unreached,
          ),
        )
        .toEqual([]);
      expect.soft(stale, named("stale unreached or reached-409 exemptions", stale)).toEqual([]);
    }, 900_000);
  },
);

// After both logins' passes: every pair the table allows was shown at least once, so a pair
// nothing shows any more is taken out instead of staying there to let a later leak through. Over
// both passes, as a pair the concurrent sweep shows only most of the time is still in use.
describeWithDatabase("the designed sharing table", () => {
  it("lists only pairs a member or guest of S was shown", () => {
    expect(designedSeen.size, "the passes that record what S shows did not run").toBeGreaterThan(0);
    const unseen = Object.entries(DESIGNED_SHARING).flatMap(([path, kinds]) =>
      kinds.filter((kind) => !designedSeen.get(path)?.has(kind)).map((kind) => `${path}: ${kind}`),
    );
    expect(unseen, "designed sharing pairs no call showed (stale entries)").toEqual([]);
  });

  it("says for every pair seen only some of the time when it is shown and when it is not", () => {
    const entries = Object.entries(DESIGNED_SHARING_SOMETIMES).flatMap(([path, list]) =>
      list.flatMap((entry) => entry.kinds.map((kind) => ({ path, kind, entry }))),
    );
    expect(entries.length).toBeGreaterThan(0);
    const bare = entries
      .filter(({ entry }) => !entry.shownWhen.trim() || !entry.hiddenWhen.trim())
      .map(({ path, kind }) => `${path}: ${kind}`);
    expect(bare, "pairs with no shownWhen or hiddenWhen").toEqual([]);
    const twice = entries
      .filter(({ path, kind }, index) =>
        entries.some((other, at) => at < index && other.path === path && other.kind === kind),
      )
      .map(({ path, kind }) => `${path}: ${kind}`);
    expect(twice, "pairs listed twice").toEqual([]);
    const required = entries
      .filter(({ path, kind }) => DESIGNED_SHARING[path]?.includes(kind))
      .map(({ path, kind }) => `${path}: ${kind}`);
    expect(required, "pairs in both the required and the sometimes table").toEqual([]);
  });
});
