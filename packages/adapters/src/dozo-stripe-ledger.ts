import type { BillingByokPlan } from "@rakazo/adapter-kit";
import { deadlineSignal, parseRetryAfter, readBoundedJsonResponse, retry } from "@rakazo/core";
import { z } from "zod";
import type {
  DozoLedger,
  DozoLedgerAccounts,
  DozoLedgerEntry,
  DozoPaymentLedger,
} from "./dozo-payment-ledger.js";
import { STRIPE_API_VERSION } from "./stripe-billing.js";

/** Payers read per call; past this the read is partial. */
export const DOZO_LEDGER_MAX_CUSTOMERS = 200;
/** Pages of 100 per list per payer; past this the read is partial. */
export const DOZO_LEDGER_MAX_PAGES = 3;
/**
 * How long before the period a payer's records are read: a payment made or refunded in the period
 * can belong to an invoice or a charge created this long before it.
 */
export const DOZO_LEDGER_LOOKBACK_MS = 400 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 6;
/** One read, every call included, ends by then. */
const READ_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/**
 * The metadata keys `stripe-billing.ts` writes on what it creates: `rakazo_plan` on every plan
 * subscription, `rakazo_credit_cents` on every credit subscription and on the payment of every
 * one-time credit purchase (which its charge carries too).
 */
const MARKERS = ["rakazo_plan", "rakazo_credit_cents"];
/** The prefix `stripe-billing.ts` gives every own-key plan price's lookup key. */
const PRICE_KEY_PREFIX = "rakazo_byok_";

const metadata = z.record(z.string(), z.string()).nullish();
const invoiceSchema = z.object({
  status: z.string().nullish(),
  amount_paid: z.number().int(),
  currency: z.string(),
  status_transitions: z.object({ paid_at: z.number().int().nullish() }).nullish(),
  parent: z
    .object({
      subscription_details: z.object({ metadata, subscription: z.string().nullish() }).nullish(),
    })
    .nullish(),
  payments: z
    .object({
      data: z.array(z.object({ payment: z.object({ payment_intent: z.string().nullish() }) })),
    })
    .nullish(),
});
type Invoice = z.infer<typeof invoiceSchema>;
const refundSchema = z.object({
  status: z.string().nullish(),
  amount: z.number().int(),
  currency: z.string(),
  created: z.number().int(),
});
const chargeSchema = z.object({
  status: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  created: z.number().int(),
  payment_intent: z.string().nullish(),
  metadata,
  refunds: z.object({ data: z.array(refundSchema), has_more: z.boolean() }).nullish(),
});
type Charge = z.infer<typeof chargeSchema>;
const pageSchema = z.object({ data: z.array(z.unknown()), has_more: z.boolean() });
const idOf = (row: unknown) => z.object({ id: z.string() }).safeParse(row).data?.id;

export interface DozoStripeLedgerConfig {
  secretKey: string;
  fetch?: typeof fetch;
  apiBase?: string;
}

/** A refused or failed call; `retry` reads its status and the wait the provider asked for. */
class LedgerReadError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
  ) {
    super(`Payment ledger read failed (${status})`);
  }
}

/** The deployment's payments, read payer by payer from the provider's invoices and charges. */
export class DozoStripeLedger implements DozoPaymentLedger {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(private readonly config: DozoStripeLedgerConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.apiBase = config.apiBase ?? "https://api.stripe.com";
  }

  /**
   * The lookup key `stripe-billing.ts` (`byokPrice`) finds or creates the plan's price under; it
   * keeps the formula private, so it is restated here and a test holds the two equal.
   */
  priceKey({ tier, interval, amountCents }: BillingByokPlan): string {
    const period = interval === "year" ? "yearly" : "monthly";
    // Standard keeps the keys its existing prices were created under.
    return tier === "standard"
      ? `${PRICE_KEY_PREFIX}${period}_${amountCents}`
      : `${PRICE_KEY_PREFIX}${tier}_${period}_${amountCents}`;
  }

  async read(
    range: { from: Date; to: Date },
    accounts: DozoLedgerAccounts,
    caller?: AbortSignal,
  ): Promise<DozoLedger> {
    const signal = deadlineSignal(READ_TIMEOUT_MS, caller);
    const customers = [...accounts.customers].sort();
    const ledger: DozoLedger = {
      entries: [],
      unclassified: 0,
      partial: customers.length > DOZO_LEDGER_MAX_CUSTOMERS,
    };
    const queue = customers.slice(0, DOZO_LEDGER_MAX_CUSTOMERS);
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let customer = queue.shift(); customer; customer = queue.shift()) {
          const read = await this.readCustomer(customer, range, accounts.subscriptions, signal);
          ledger.entries.push(...read.entries);
          ledger.unclassified += read.unclassified;
          ledger.partial ||= read.partial;
        }
      }),
    );
    ledger.entries.sort((a, b) => b.at.getTime() - a.at.getTime());
    return ledger;
  }

  /**
   * One payer's records in the period. A record counts only when it shows it is the deployment's:
   * an invoice by its subscription's mark, a subscription a billing account holds, or a payment of
   * a marked credit purchase; a charge, and its refunds, by its own mark or by paying such an
   * invoice. Anything else in the period, or a record that cannot be read, is unclassified.
   */
  private async readCustomer(
    customer: string,
    range: { from: Date; to: Date },
    subscriptions: ReadonlySet<string>,
    signal: AbortSignal,
  ) {
    const from = seconds(range.from);
    const to = seconds(range.to);
    const since = seconds(new Date(range.from.getTime() - DOZO_LEDGER_LOOKBACK_MS));
    const query = `customer=${encodeURIComponent(customer)}&created[gte]=${since}&created[lt]=${to}`;
    const [invoiceRows, chargeRows] = await Promise.all([
      this.list(`/v1/invoices?${query}&expand[]=data.payments`, signal),
      this.list(`/v1/charges?${query}&expand[]=data.refunds`, signal),
    ]);
    let unclassified = 0;
    const parse = <T>(schema: z.ZodType<T>, rows: unknown[]) =>
      rows.flatMap((row) => {
        const parsed = schema.safeParse(row);
        if (!parsed.success) unclassified++;
        return parsed.success ? [parsed.data] : [];
      });
    const invoices = parse(invoiceSchema, invoiceRows.rows);
    const charges = parse(chargeSchema, chargeRows.rows);
    const inPeriod = (at: number) => at >= from && at < to;
    const marked = (marks: Record<string, string> | null | undefined) =>
      MARKERS.some((key) => marks?.[key]);
    const intentsOf = (invoice: Invoice) =>
      invoice.payments?.data.flatMap((row) => row.payment.payment_intent ?? []) ?? [];
    const creditIntents = new Set(
      charges.flatMap((charge) => (marked(charge.metadata) && charge.payment_intent) || []),
    );
    const isOurs = (invoice: Invoice) => {
      const subscription = invoice.parent?.subscription_details;
      return (
        marked(subscription?.metadata) ||
        subscriptions.has(subscription?.subscription ?? "") ||
        intentsOf(invoice).some((intent) => creditIntents.has(intent))
      );
    };
    const ourIntents = new Set([...creditIntents, ...invoices.filter(isOurs).flatMap(intentsOf)]);
    const chargeIsOurs = (charge: Charge) =>
      marked(charge.metadata) || ourIntents.has(charge.payment_intent ?? "");

    const entries: DozoLedgerEntry[] = [];
    const add = (ours: boolean, entry: Omit<DozoLedgerEntry, "customerId">) => {
      if (ours) entries.push({ customerId: customer, ...entry });
      else unclassified++;
    };
    let partial = invoiceRows.partial || chargeRows.partial;
    for (const invoice of invoices) {
      // Dated, and placed in a period, by when it was paid.
      const paidAt = invoice.status_transitions?.paid_at;
      if (invoice.status === "paid" && invoice.amount_paid > 0 && paidAt && inPeriod(paidAt))
        add(isOurs(invoice), {
          amount: invoice.amount_paid,
          currency: invoice.currency,
          at: fromSeconds(paidAt),
          status: "paid",
        });
    }
    for (const charge of charges) {
      const ours = chargeIsOurs(charge);
      if (charge.status === "failed" && inPeriod(charge.created))
        add(ours, {
          amount: charge.amount,
          currency: charge.currency,
          at: fromSeconds(charge.created),
          status: "failed",
        });
      partial ||= Boolean(charge.refunds?.has_more);
      for (const refund of charge.refunds?.data ?? [])
        if (refund.status === "succeeded" && inPeriod(refund.created))
          add(ours, {
            amount: refund.amount,
            currency: refund.currency,
            at: fromSeconds(refund.created),
            status: "refunded",
          });
    }
    return { entries, unclassified, partial };
  }

  /** Newest first, at most `DOZO_LEDGER_MAX_PAGES` pages. */
  private async list(path: string, signal: AbortSignal) {
    const rows: unknown[] = [];
    let after: string | undefined;
    for (let page = 0; page < DOZO_LEDGER_MAX_PAGES; page++) {
      const query = `&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`;
      const { data, has_more } = pageSchema.parse(
        await retry(() => this.get(`${path}${query}`, signal), { attempts: 3, signal }),
      );
      rows.push(...data);
      after = idOf(data.at(-1));
      if (!has_more || !after) return { rows, partial: false };
    }
    return { rows, partial: true };
  }

  private async get(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${this.config.secretKey}`,
        "Stripe-Version": STRIPE_API_VERSION,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new LedgerReadError(
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    return readBoundedJsonResponse(response, MAX_RESPONSE_BYTES, signal);
  }
}

function seconds(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

function fromSeconds(value: number) {
  return new Date(value * 1000);
}
