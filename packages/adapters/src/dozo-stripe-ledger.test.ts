import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DOZO_LEDGER_LOOKBACK_MS,
  DOZO_LEDGER_MAX_CUSTOMERS,
  DOZO_LEDGER_MAX_PAGES,
  DozoStripeLedger,
} from "./dozo-stripe-ledger.js";

const range = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-19T00:00:00Z") };
const at = (month: number, day: number) => Math.floor(Date.UTC(2026, month - 1, day) / 1000);
const accounts = { customers: new Set(["cus_ours"]), subscriptions: new Set(["sub_known"]) };
const plan = (subscription: string) => ({
  subscription_details: { metadata: { rakazo_plan: "byok" }, subscription },
});
const paid = (day: number, month = 11) => ({ paid_at: at(month, day) });
const intents = (...ids: string[]) => ({
  data: ids.map((id) => ({ payment: { payment_intent: id } })),
});
const refunds = (...data: object[]) => ({ data, has_more: false });

type Lists = Record<string, unknown[]>;

function ledger(lists: Lists, hasMore: (path: string) => boolean = () => false) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    const data = lists[`${url.pathname}?${url.searchParams.get("customer")}`] ?? [];
    return Response.json({ data, has_more: hasMore(url.pathname) && data.length > 0 });
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

// One payer of the deployment who also pays another product on the same payment account.
const shared: Lists = {
  "/v1/invoices?cus_ours": [
    {
      id: "in_plan",
      status: "paid",
      amount_paid: 900,
      currency: "usd",
      status_transitions: paid(3),
      parent: plan("sub_old"),
      payments: intents("pi_plan"),
    },
    // No mark, but a subscription the deployment's billing account holds.
    {
      id: "in_sub",
      status: "paid",
      amount_paid: 800,
      currency: "usd",
      status_transitions: paid(4),
      parent: { subscription_details: { subscription: "sub_known" } },
    },
    // A one-time credit purchase: its payment carries the credit mark.
    {
      id: "in_credit",
      status: "paid",
      amount_paid: 500,
      currency: "usd",
      status_transitions: paid(6),
      payments: intents("pi_credit"),
    },
    // Created in October, paid in November: November's.
    {
      id: "in_late",
      status: "paid",
      amount_paid: 700,
      currency: "usd",
      status_transitions: paid(2),
      parent: plan("sub_old"),
    },
    // Created and paid in October: not this period's at all.
    {
      id: "in_early",
      status: "paid",
      amount_paid: 700,
      currency: "usd",
      status_transitions: paid(30, 10),
      parent: plan("sub_old"),
    },
    // The other product's invoice for the same payer.
    {
      id: "in_other",
      status: "paid",
      amount_paid: 7000,
      currency: "usd",
      status_transitions: paid(5),
      parent: { subscription_details: { metadata: { app: "else" }, subscription: "sub_other" } },
      payments: intents("pi_other"),
    },
    { id: "in_open", status: "open", amount_paid: 0, currency: "usd", parent: plan("sub_old") },
    // A record that cannot be read is never counted as ours.
    { id: "in_bad", status: "paid" },
  ],
  "/v1/charges?cus_ours": [
    {
      id: "ch_credit",
      status: "succeeded",
      amount: 500,
      currency: "usd",
      created: at(11, 6),
      payment_intent: "pi_credit",
      metadata: { rakazo_credit_cents: "500" },
      refunds: refunds({ status: "succeeded", amount: 200, currency: "usd", created: at(11, 8) }),
    },
    {
      id: "ch_plan_failed",
      status: "failed",
      amount: 900,
      currency: "usd",
      created: at(11, 9),
      payment_intent: "pi_plan",
      metadata: {},
    },
    // The other product's failed payment and refund for the same payer.
    {
      id: "ch_other_failed",
      status: "failed",
      amount: 900,
      currency: "usd",
      created: at(11, 9),
      payment_intent: "pi_other2",
      metadata: {},
    },
    {
      id: "ch_other",
      status: "succeeded",
      amount: 7000,
      currency: "usd",
      created: at(11, 5),
      payment_intent: "pi_other",
      metadata: {},
      refunds: refunds({ status: "succeeded", amount: 7000, currency: "usd", created: at(11, 10) }),
    },
    // A September payment whose refund is still pending, and an old failure.
    {
      id: "ch_old",
      status: "succeeded",
      amount: 900,
      currency: "usd",
      created: at(9, 3),
      payment_intent: "pi_plan",
      metadata: {},
      refunds: refunds({ status: "pending", amount: 900, currency: "usd", created: at(11, 11) }),
    },
    {
      id: "ch_old_failed",
      status: "failed",
      amount: 900,
      currency: "usd",
      created: at(10, 3),
      payment_intent: "pi_plan",
      metadata: {},
    },
  ],
};

describe("the payment ledger", () => {
  it("counts a record only when it shows it is the deployment's, even for the deployment's payer", async () => {
    const { reader } = ledger(shared);
    const result = await reader.read(range, accounts);
    expect(result.partial).toBe(false);
    expect(
      result.entries.map((entry) => [entry.status, entry.amount, entry.at.getUTCDate()]),
    ).toEqual([
      ["failed", 900, 9],
      ["refunded", 200, 8],
      ["paid", 500, 6],
      ["paid", 800, 4],
      ["paid", 900, 3],
      ["paid", 700, 2],
    ]);
    expect(result.entries.every((entry) => entry.customerId === "cus_ours")).toBe(true);
    // The other product's invoice, failed payment and refund, and the unreadable invoice.
    expect(result.unclassified).toBe(4);
  });

  it("asks the provider for each of the deployment's payers only, from before the period", async () => {
    const { reader, calls } = ledger({});
    await reader.read(range, { ...accounts, customers: new Set(["cus_b", "cus_a"]) });
    expect(
      calls.map(({ url }) => `${url.pathname}?${url.searchParams.get("customer")}`).sort(),
    ).toEqual([
      "/v1/charges?cus_a",
      "/v1/charges?cus_b",
      "/v1/invoices?cus_a",
      "/v1/invoices?cus_b",
    ]);
    const since = (range.from.getTime() - DOZO_LEDGER_LOOKBACK_MS) / 1000;
    for (const { url, init } of calls) {
      expect(url.searchParams.get("created[gte]")).toBe(String(since));
      expect(url.searchParams.get("created[lt]")).toBe(String(range.to.getTime() / 1000));
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.get("expand[]")).toBe(
        url.pathname === "/v1/invoices" ? "data.payments" : "data.refunds",
      );
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk_test_fixture");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("ends its requests when the caller's signal does", async () => {
    const { reader, calls } = ledger({});
    const caller = new AbortController();
    await reader.read(range, accounts, caller.signal);
    caller.abort();
    expect(calls.length).toBeGreaterThan(0);
    for (const { init } of calls) expect(init.signal?.aborted).toBe(true);
  });

  it("says the read is partial past the payers, pages or refunds it reads", async () => {
    const many = new Set(
      Array.from({ length: DOZO_LEDGER_MAX_CUSTOMERS + 1 }, (_, i) => `cus_${i}`),
    );
    const tooMany = await ledger({}).reader.read(range, { ...accounts, customers: many });
    expect(tooMany.partial).toBe(true);

    const pages = ledger(shared, (path) => path === "/v1/invoices");
    expect((await pages.reader.read(range, accounts)).partial).toBe(true);
    const invoicePages = pages.calls.filter(({ url }) => url.pathname === "/v1/invoices");
    expect(invoicePages).toHaveLength(DOZO_LEDGER_MAX_PAGES);
    expect(invoicePages[1]?.url.searchParams.get("starting_after")).toBe("in_bad");

    const moreRefunds = ledger({
      "/v1/charges?cus_ours": [
        {
          id: "ch_1",
          status: "succeeded",
          amount: 1,
          currency: "usd",
          created: at(11, 2),
          metadata: { rakazo_credit_cents: "1" },
          refunds: { data: [], has_more: true },
        },
      ],
    });
    expect((await moreRefunds.reader.read(range, accounts)).partial).toBe(true);
  });

  it("asks again when the provider is busy, and fails a refusal without repeating the key", async () => {
    let busy = true;
    const fetch = vi.fn(async (_input: string | URL | Request) => {
      if (busy) {
        busy = false;
        return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
      }
      return Response.json({ data: [], has_more: false });
    });
    const result = await new DozoStripeLedger({ secretKey: "sk_test_fixture", fetch }).read(
      range,
      accounts,
    );
    expect(result.entries).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/^https:\/\/api\.stripe\.com\/v1\//);

    const refused = vi.fn(async () =>
      Response.json({ error: { message: "sk_test_fixture is bad" } }, { status: 401 }),
    );
    const error = await new DozoStripeLedger({ secretKey: "sk_test_fixture", fetch: refused })
      .read(range, accounts)
      .then(
        () => null,
        (failure: Error) => failure,
      );
    expect(error?.message).toBe("Payment ledger read failed (401)");
    expect(refused).toHaveBeenCalledTimes(2);
  });
});

describe("a plan's price key", () => {
  const reader = new DozoStripeLedger({ secretKey: "sk_test_fixture" });

  it("is the key the billing adapter finds or creates the price under", () => {
    expect(reader.priceKey({ tier: "pro", interval: "month", amountCents: 4900 })).toBe(
      "rakazo_byok_pro_monthly_4900",
    );
    expect(reader.priceKey({ tier: "max", interval: "year", amountCents: 94800 })).toBe(
      "rakazo_byok_max_yearly_94800",
    );
    expect(reader.priceKey({ tier: "standard", interval: "month", amountCents: 1500 })).toBe(
      "rakazo_byok_monthly_1500",
    );
  });

  it("follows the billing adapter's own formula, which it keeps private", () => {
    const source = readFileSync(new URL("./stripe-billing.ts", import.meta.url), "utf8");
    expect(source).toContain('const BYOK_PRICE_KEY_PREFIX = "rakazo_byok_";');
    expect(source).toContain('const period = interval === "year" ? "yearly" : "monthly";');
    expect(source).toMatch(/`\$\{BYOK_PRICE_KEY_PREFIX\}\$\{period\}_\$\{amountCents\}`/);
    expect(source).toMatch(/`\$\{BYOK_PRICE_KEY_PREFIX\}\$\{tier\}_\$\{period\}_\$\{amountCents\}`/);
  });
});
