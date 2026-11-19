import type { ReactNode } from "react";

/** A bordered list of `Row`s. */
export function Rows({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <ul data-testid={testId} className="divide-y divide-border rounded-xl border border-border">
      {children}
    </ul>
  );
}

/**
 * One item: a title, a line of details and its actions on the right. The title and details keep
 * at least 16rem, so a long row moves its actions to a line of their own instead of squeezing the
 * email into a few characters; the actions wrap among themselves on a narrow screen.
 */
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
    <li
      aria-label={label}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-body-sm"
    >
      <div data-row-identity className="min-w-0 max-w-full flex-1 basis-64">
        <div title={label} className="truncate text-body font-medium">
          {title}
        </div>
        <div className="flex min-w-0 flex-wrap gap-x-3 text-muted-foreground">{details}</div>
      </div>
      {children ? (
        <div data-row-actions className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {children}
        </div>
      ) : null}
    </li>
  );
}
