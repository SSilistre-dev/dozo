/** One payment, refund or failed payment as the payment provider recorded it. */
export interface DozoLedgerEntry {
  /** The provider's id for the payer, matched against the deployment's billing accounts. */
  customerId: string | null;
  /** In the currency's minor unit (cents), as the provider reports it. */
  amount: number;
  currency: string;
  at: Date;
  status: "paid" | "refunded" | "failed";
}

export interface DozoLedger {
  /** Newest first. */
  entries: DozoLedgerEntry[];
  /** The provider held more records than one read takes; `entries` are the newest. */
  partial: boolean;
}

/**
 * Reads what the deployment was paid, read-only, for the admin billing page. The payment account
 * may also hold other products' payments: an implementation returns only this deployment's, those
 * of a payer in `customers` or carrying the marker the deployment's own checkout writes.
 */
export interface DozoPaymentLedger {
  read(range: { from: Date; to: Date }, customers: ReadonlySet<string>): Promise<DozoLedger>;
}
