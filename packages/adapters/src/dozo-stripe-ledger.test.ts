import { describe, expect, it, vi } from "vitest";
import { DOZO_LEDGER_MAX_PAGES, DozoStripeLedger } from "./dozo-stripe-ledger.js";

const range = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-19T00:00:00Z") };
const ours = new Set(["cus_ours"]);
const plan = { subscription_details: { metadata: { rakazo_plan: "byok" } } };
const at = (day: number) => Math.floor(Date.UTC(2026, 10, day) / 1000);

function ledger(lists: Record<string, unknown[]>, more: { hasMore?: boolean } = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    const data = lists[url.pathname] ?? [];
    return Response.json({ data, has_more: Boolean(more.hasMore) && data.length > 0 });
  });
  return {
    reader: new DozoStripeLedger({
      secretKey: "sk_test_fixture",
      fetch,
      apiBase: "https://pay.test",
    }),
    calls,
  };
}

describe("the payment ledger", () => {
  it("counts only the deployment's own records on a shared payment account", async () => {
    const { reader } = ledger({
      "/v1/invoices": [
        // A plan subscription whose payer the deployment no longer lists: its marker counts.
        {
          id: "in_1",
          customer: "cus_gone",
          status: "paid",
          amount_paid: 900,
          currency: "usd",
          created: at(3),
          parent: plan,
        },
        // A payer the deployment lists, without a marker (a one-time credit purchase).
        {
          id: "in_2",
          customer: "cus_ours",
          status: "paid",
          amount_paid: 500,
          currency: "usd",
          created: at(2),
          status_transitions: { paid_at: at(4) },
        },
        // Another product's subscription on the same account.
        {
          id: "in_3",
          customer: "cus_other",
          status: "paid",
          amount_paid: 7000,
          currency: "usd",
          created: at(5),
          parent: { subscription_details: { metadata: { app: "else" } } },
        },
        {
          id: "in_4",
          customer: "cus_other",
          status: "paid",
          amount_paid: 7000,
          currency: "usd",
          created: at(5),
        },
        // Not paid, or nothing paid.
        {
          id: "in_5",
          customer: "cus_ours",
          status: "open",
          amount_paid: 0,
          currency: "usd",
          created: at(6),
        },
        {
          id: "in_6",
          customer: "cus_ours",
          status: "paid",
          amount_paid: 0,
          currency: "usd",
          created: at(6),
        },
      ],
      "/v1/refunds": [
        {
          id: "re_1",
          status: "succeeded",
          amount: 200,
          currency: "usd",
          created: at(7),
          charge: { customer: "cus_ours" },
        },
        {
          id: "re_2",
          status: "succeeded",
          amount: 150,
          currency: "usd",
          created: at(8),
          charge: { customer: null, metadata: { rakazo_credit_cents: "1000" } },
        },
        {
          id: "re_3",
          status: "succeeded",
          amount: 999,
          currency: "usd",
          created: at(8),
          charge: { customer: "cus_other", metadata: {} },
        },
        {
          id: "re_4",
          status: "pending",
          amount: 999,
          currency: "usd",
          created: at(8),
          charge: { customer: "cus_ours" },
        },
        // Not expanded: nothing says whose it is.
        {
          id: "re_5",
          status: "succeeded",
          amount: 999,
          currency: "usd",
          created: at(8),
          charge: "ch_1",
        },
      ],
      "/v1/charges": [
        {
          id: "ch_1",
          customer: "cus_ours",
          status: "failed",
          amount: 900,
          currency: "usd",
          created: at(9),
        },
        {
          id: "ch_2",
          customer: "cus_other",
          status: "failed",
          amount: 900,
          currency: "usd",
          created: at(9),
        },
        {
          id: "ch_3",
          customer: "cus_ours",
          status: "succeeded",
          amount: 900,
          currency: "usd",
          created: at(9),
        },
      ],
    });
    const result = await reader.read(range, ours);
    expect(result.partial).toBe(false);
    expect(result.entries.map((entry) => [entry.customerId, entry.status, entry.amount])).toEqual([
      ["cus_ours", "failed", 900],
      [null, "refunded", 150],
      ["cus_ours", "refunded", 200],
      ["cus_ours", "paid", 500],
      ["cus_gone", "paid", 900],
    ]);
    // A paid invoice is dated when it was paid.
    expect(result.entries[3]?.at).toEqual(new Date(at(4) * 1000));
  });

  it("reads the period from each list, newest first, with the account's key", async () => {
    const { reader, calls } = ledger({});
    await reader.read(range, ours);
    expect(calls.map(({ url }) => url.pathname).sort()).toEqual([
      "/v1/charges",
      "/v1/invoices",
      "/v1/refunds",
    ]);
    for (const { url, init } of calls) {
      expect(url.searchParams.get("created[gte]")).toBe(String(range.from.getTime() / 1000));
      expect(url.searchParams.get("created[lt]")).toBe(String(range.to.getTime() / 1000));
      expect(url.searchParams.get("limit")).toBe("100");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk_test_fixture");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(
      calls.find(({ url }) => url.pathname === "/v1/refunds")?.url.searchParams.get("expand[]"),
    ).toBe("data.charge");
  });

  it("stops after a bounded number of pages and says the figures are partial", async () => {
    const { reader, calls } = ledger(
      {
        "/v1/invoices": [
          {
            id: "in_1",
            customer: "cus_ours",
            status: "paid",
            amount_paid: 1,
            currency: "usd",
            created: at(1),
          },
        ],
      },
      { hasMore: true },
    );
    const result = await reader.read(range, ours);
    const invoicePages = calls.filter(({ url }) => url.pathname === "/v1/invoices");
    expect(invoicePages).toHaveLength(DOZO_LEDGER_MAX_PAGES);
    expect(invoicePages[1]?.url.searchParams.get("starting_after")).toBe("in_1");
    expect(result.partial).toBe(true);
    expect(result.entries).toHaveLength(DOZO_LEDGER_MAX_PAGES);
  });

  it("fails a refused read without repeating the key", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request) =>
      Response.json({ error: { message: "sk_test_fixture is bad" } }, { status: 401 }),
    );
    const reader = new DozoStripeLedger({ secretKey: "sk_test_fixture", fetch });
    const error = await reader.read(range, ours).then(
      () => null,
      (failure: Error) => failure,
    );
    expect(error?.message).toBe("Payment ledger read failed (401)");
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/^https:\/\/api\.stripe\.com\/v1\//);
  });
});
