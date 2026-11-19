import { readBoundedJsonResponse } from "@rakazo/core";
import { z } from "zod";
import type { DozoLedger, DozoLedgerEntry, DozoPaymentLedger } from "./dozo-payment-ledger.js";
import { STRIPE_API_VERSION } from "./stripe-billing.js";

/** Pages of 100 per list; past this the read is marked partial. */
export const DOZO_LEDGER_MAX_PAGES = 10;
/** One read, every page of every list, ends by then. */
const READ_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/**
 * The metadata keys `stripe-billing.ts` writes on every plan and credit subscription and credit
 * payment it creates. The account is shared with other products, so a record counts only with one
 * of them or a payer the deployment's own billing accounts name.
 */
const MARKERS = ["rakazo_plan", "rakazo_credit_cents"];

const metadata = z.record(z.string(), z.string()).nullish();
const invoiceSchema = z.object({
  customer: z.string().nullish(),
  status: z.string().nullish(),
  amount_paid: z.number().int(),
  currency: z.string(),
  created: z.number().int(),
  status_transitions: z.object({ paid_at: z.number().int().nullish() }).nullish(),
  parent: z.object({ subscription_details: z.object({ metadata }).nullish() }).nullish(),
});
const chargeSchema = z.object({
  customer: z.string().nullish(),
  status: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  created: z.number().int(),
  metadata,
});
const refundSchema = z.object({
  status: z.string().nullish(),
  amount: z.number().int(),
  currency: z.string(),
  created: z.number().int(),
  charge: z.union([z.string(), chargeSchema.pick({ customer: true, metadata: true })]).nullish(),
});
const pageSchema = z.object({ data: z.array(z.unknown()), has_more: z.boolean() });

export interface DozoStripeLedgerConfig {
  secretKey: string;
  fetch?: typeof fetch;
  apiBase?: string;
}

/** The deployment's payments, read from the provider's invoices, refunds and charges. */
export class DozoStripeLedger implements DozoPaymentLedger {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(private readonly config: DozoStripeLedgerConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.apiBase = config.apiBase ?? "https://api.stripe.com";
  }

  async read(range: { from: Date; to: Date }, customers: ReadonlySet<string>): Promise<DozoLedger> {
    const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
    const created = `created[gte]=${seconds(range.from)}&created[lt]=${seconds(range.to)}`;
    const [invoices, refunds, charges] = await Promise.all([
      this.list(`/v1/invoices?${created}`, invoiceSchema, signal),
      this.list(`/v1/refunds?${created}&expand[]=data.charge`, refundSchema, signal),
      this.list(`/v1/charges?${created}`, chargeSchema, signal),
    ]);
    const ours = (
      customer: string | null | undefined,
      marks: Record<string, string> | null | undefined,
    ) => Boolean(customer && customers.has(customer)) || MARKERS.some((key) => marks?.[key]);
    const entries: DozoLedgerEntry[] = [];
    for (const invoice of invoices.rows)
      if (
        invoice.status === "paid" &&
        invoice.amount_paid > 0 &&
        ours(invoice.customer, invoice.parent?.subscription_details?.metadata)
      )
        entries.push({
          customerId: invoice.customer ?? null,
          amount: invoice.amount_paid,
          currency: invoice.currency,
          at: fromSeconds(invoice.status_transitions?.paid_at ?? invoice.created),
          status: "paid",
        });
    for (const refund of refunds.rows) {
      const charge = typeof refund.charge === "object" ? refund.charge : null;
      if (refund.status === "succeeded" && ours(charge?.customer, charge?.metadata))
        entries.push({
          customerId: charge?.customer ?? null,
          amount: refund.amount,
          currency: refund.currency,
          at: fromSeconds(refund.created),
          status: "refunded",
        });
    }
    for (const charge of charges.rows)
      if (charge.status === "failed" && ours(charge.customer, charge.metadata))
        entries.push({
          customerId: charge.customer ?? null,
          amount: charge.amount,
          currency: charge.currency,
          at: fromSeconds(charge.created),
          status: "failed",
        });
    entries.sort((a, b) => b.at.getTime() - a.at.getTime());
    return { entries, partial: invoices.partial || refunds.partial || charges.partial };
  }

  /** Newest first, at most `DOZO_LEDGER_MAX_PAGES` pages. */
  private async list<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal) {
    const rows: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < DOZO_LEDGER_MAX_PAGES; page++) {
      const query = `&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`;
      const { data, has_more } = pageSchema.parse(await this.get(`${path}${query}`, signal));
      rows.push(...data.map((row) => schema.parse(row)));
      const last = z.object({ id: z.string() }).safeParse(data.at(-1)).data?.id;
      if (!has_more || !last) return { rows, partial: false };
      after = last;
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
      throw new Error(`Payment ledger read failed (${response.status})`);
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
