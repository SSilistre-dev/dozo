import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { MarkdownCopy } from "@rakazo/chat-ui/native";
import { MarkdownCopyProvider, MathViewContext, TableToolsContext } from "@rakazo/chat-ui/native";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { MathView } from "./dozo-math-view";
import { TableTools } from "./dozo-table-tools";

/**
 * What chat Markdown needs from the app beyond upstream's: the formula drawing, the controls on a
 * table, and the table's words. They are the web's strings (`MarkdownChrome`), so every language
 * already has them.
 */
export function DozoMarkdownProviders({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const copy = useMemo<MarkdownCopy>(
    () => ({
      copied: t`Copied`,
      copyCode: t`Copy code`,
      copyDiagramSource: t`Copy diagram source`,
      table: t`Table`,
      markdownTable: t`Markdown table`,
      row: t`Row`,
      noRows: t`No rows`,
      previousPage: t`Previous page`,
      nextPage: t`Next page`,
      copyRows: t`Copy rows`,
      downloadCsv: t`Download CSV`,
      expandTable: t`Expand table`,
      closeTable: t`Close table`,
      sortCleared: t`Sort cleared`,
      pageOf: (page, count) => t`Page ${page} of ${count}`,
      rowCount: (count) => t`${plural(count, { one: "# row", other: "# rows" })}`,
      rowRange: (from, to, total) => t`${from}–${to} of ${total} rows`,
      columnFallback: (index) => t`column ${index}`,
      columnDuplicate: (header, index) => t`${header}, column ${index}`,
      columnCollision: (label) => t`${label}, empty`,
      sortBy: (column) => t`Sort by ${column}`,
      sortedBy: (column, direction) =>
        direction === "asc"
          ? t`Sorted by ${column}, ascending`
          : t`Sorted by ${column}, descending`,
    }),
    [t],
  );
  return (
    <MarkdownCopyProvider copy={copy}>
      <MathViewContext.Provider value={MathView}>
        <TableToolsContext.Provider value={TableTools}>{children}</TableToolsContext.Provider>
      </MathViewContext.Provider>
    </MarkdownCopyProvider>
  );
}
