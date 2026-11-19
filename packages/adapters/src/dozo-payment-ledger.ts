/** One payment, refund or failed payment as the payment provider recorded it. */
export interface DozoLedgerEntry {
  /** The provider's id for the payer, matched against the deployment's billing accounts. */
  customerId: string;
  /** In the currency's minor unit (cents), as the provider reports it. */
  amount: number;
  currency: string;
  /** When it was paid, refunded or declined. */
  at: Date;
  status: "paid" | "refunded" | "failed";
}

export interface DozoLedger {
  /** Newest first. */
  entries: DozoLedgerEntry[];
  /**
   * Records in the period held by the deployment's payers that do not show they are the
   * deployment's (another product on the same payer, or an older record without a mark). Never
   * in `entries`.
   */
  unclassified: number;
  /** Not every record was read: `entries` are not the whole period. */
  partial: boolean;
}

/** The deployment's payers, and the subscriptions its billing accounts hold, as the provider names them. */
export interface DozoLedgerAccounts {
  customers: ReadonlySet<string>;
  subscriptions: ReadonlySet<string>;
}

/**
 * Reads what the deployment was paid, read-only, for the admin billing page. The payment account
 * may also hold other products' payments, even for the same payer: an implementation reads only
 * the deployment's payers and returns a record only when the record itself shows it is the
 * deployment's.
 */
export interface DozoPaymentLedger {
  /** `signal` ends the read early, on top of the implementation's own time limit. */
  read(
    range: { from: Date; to: Date },
    accounts: DozoLedgerAccounts,
    signal?: AbortSignal,
  ): Promise<DozoLedger>;
}
