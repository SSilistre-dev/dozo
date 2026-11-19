import type { ReactNode } from "react";

/** A bordered list of `Row`s. */
export function Rows({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <ul data-testid={testId} className="divide-y divide-border rounded-xl border border-border">
      {children}
    </ul>
  );
}

/** One item: a title, a line of details and its actions on the right. */
export function Row({
  label,
  title,
  details,
  children,
}: {
  label: string;
  title: ReactNode;
  /** One `span` per field. */
  details: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li aria-label={label} className="flex items-center gap-3 px-4 py-3 text-body-sm">
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-medium">{title}</div>
        <div className="flex min-w-0 flex-wrap gap-x-3 text-muted-foreground">{details}</div>
      </div>
      {children}
    </li>
  );
}
