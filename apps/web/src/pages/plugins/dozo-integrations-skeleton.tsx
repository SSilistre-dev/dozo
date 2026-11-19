const ROWS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Placeholder rows in the catalog's two-column grid while a part of the integrations page loads.
 * Each row has a real row's height, so the list does not jump when the rows arrive.
 */
export function IntegrationRowsSkeleton({ label, rows }: { label: string; rows: number }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="grid grid-cols-2 gap-2">
      {ROWS.slice(0, rows).map((row) => (
        <div key={row} className="flex min-w-0 items-center gap-3 px-2.5 py-2">
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-xl bg-muted" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-2/5 animate-pulse rounded-md bg-muted" />
            <div className="h-3 w-3/4 animate-pulse rounded-md bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}
