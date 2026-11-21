import { typeScale } from "@rakazo/ui-tokens";
import type { ASTNode } from "@ronradtke/react-native-markdown-display";
import type { ComponentProps, ComponentType, ReactElement, ReactNode } from "react";
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useMemo,
  useState,
} from "react";
import { Pressable, Text, View } from "react-native";
import { useMarkdownCopy } from "../markdown-copy";
import type { ExtractedTable, HastNode, TableSortDirection } from "../table-utils";
import { columnSortLabel, extractTable, nextSort, sortRows, tableToCsv } from "../table-utils";
import { cellPlainText } from "./ast";
import { DiagramSurfaceContext } from "./code";
import {
  TableCell as BaseTableCell,
  TableScrollView as BaseTableScrollView,
  TableRow,
} from "./table";

export { TableRow };

type Sort = { column: number; direction: TableSortDirection };

export type TableToolsProps = {
  /** The table as it is shown (sorted as the reader sorted it), as CSV with a header row. */
  csv: string;
  /** The table again, for the app to show full screen. Its headers sort the same table. */
  renderTable: () => ReactNode;
};

/**
 * The app's controls for one table: share it as CSV and open it full screen. Without them a
 * table still sorts.
 */
export const TableToolsContext = createContext<ComponentType<TableToolsProps> | null>(null);

type HeaderState = {
  columns: string[];
  sort: Sort | null;
  onSort: (column: number) => void;
};

/** Set around a table's header section only, so its cells are the ones that sort. */
const HeaderContext = createContext<HeaderState | null>(null);

/** The words a cell holds, for sorting and CSV. A formula is its TeX, as on the web. */
function plainText(node: ASTNode): string {
  if (node.type === "dozo_math_inline") return node.content;
  return node.children.length > 0 ? node.children.map(plainText).join("") : cellPlainText(node);
}

function tableRowNodes(node: ASTNode): ASTNode[] {
  return node.children.flatMap((child) => (child.type === "tr" ? [child] : tableRowNodes(child)));
}

/** The table in the shape `extractTable` reads, so web and mobile sort and export alike. */
function hastOf(table: ASTNode): HastNode {
  return {
    tagName: "table",
    children: tableRowNodes(table).map((row) => ({
      tagName: "tr",
      children: row.children.map((cell) => ({
        tagName: cell.type === "th" ? "th" : "td",
        children: [{ type: "text", value: plainText(cell) }],
      })),
    })),
  };
}

type Section = ReactElement<{ children?: ReactNode }>;

/**
 * The rendered sections with the body's rows in `order` (indexes into the original rows) and the
 * header marked for sorting. A body that is not what the renderer makes is left as it was.
 */
function shownSections(
  table: ASTNode,
  children: ReactNode,
  order: number[] | null,
  header: HeaderState,
): ReactNode {
  if (!Array.isArray(children)) return children;
  return children.map((section, at) => {
    const kind = table.children[at]?.type;
    if (!isValidElement<{ children?: ReactNode }>(section)) return section;
    if (kind === "thead") {
      return (
        <HeaderContext.Provider key={section.key} value={header}>
          {section}
        </HeaderContext.Provider>
      );
    }
    if (kind !== "tbody" || !order) return section;
    const rows = Children.toArray((section as Section).props.children);
    if (rows.length !== order.length) return section;
    return cloneElement(
      section,
      {},
      order.map((i) => rows[i]),
    );
  });
}

/** A header cell is a button that steps its column through ascending, descending and unsorted. */
export function TableCell(props: ComponentProps<typeof BaseTableCell>) {
  const header = useContext(HeaderContext);
  const copy = useMarkdownCopy();
  const { palette } = useContext(DiagramSurfaceContext);
  if (!header) return <BaseTableCell {...props} />;
  const { columnIndex, children } = props;
  const label = columnSortLabel(header.columns, columnIndex, copy);
  const direction = header.sort?.column === columnIndex ? header.sort.direction : null;
  return (
    <BaseTableCell {...props}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={direction ? copy.sortedBy(label, direction) : copy.sortBy(label)}
        accessibilityState={{ selected: direction !== null }}
        hitSlop={6}
        onPress={() => header.onSort(columnIndex)}
        style={{ flexDirection: "row", alignItems: "flex-start", gap: 4 }}
      >
        <View style={{ flexShrink: 1 }}>{children}</View>
        {direction ? (
          <Text
            importantForAccessibility="no"
            style={{ color: palette.mutedForeground, fontSize: typeScale.caption.fontSize }}
          >
            {direction === "asc" ? "↑" : "↓"}
          </Text>
        ) : null}
      </Pressable>
    </BaseTableCell>
  );
}

/**
 * The chat table with sorting by header and, when the app supplies them, CSV sharing and a full
 * screen view. The columns and rows come from `table-utils`, the same code the web table uses.
 */
export function TableScrollView(props: ComponentProps<typeof BaseTableScrollView>) {
  const { table, children, style } = props;
  const Tools = useContext(TableToolsContext);
  const model = useMemo(() => extractTable(hastOf(table)), [table]);
  const [picked, setPicked] = useState<{ schemaKey: string; sort: Sort | null }>();
  // A table whose columns changed (a reply still streaming in) starts unsorted again.
  const sort = model && picked?.schemaKey === model.schemaKey ? picked.sort : null;
  const header: HeaderState = {
    columns: model?.columns ?? [],
    sort,
    onSort: (column) =>
      model && setPicked({ schemaKey: model.schemaKey, sort: nextSort(sort, column) }),
  };
  const order = useMemo(() => (model && sort ? orderOf(model, sort) : null), [model, sort]);
  const csv = useMemo(() => {
    if (!model) return "";
    const rows = order ? order.map((i) => model.rows[i] as string[]) : model.rows;
    return tableToCsv(model.columns, rows);
  }, [model, order]);
  const shown = (
    <BaseTableScrollView table={table} style={style}>
      {shownSections(table, children, order, header)}
    </BaseTableScrollView>
  );
  if (!Tools || !model) return shown;
  return (
    <>
      <Tools csv={csv} renderTable={() => shown} />
      {shown}
    </>
  );
}

function orderOf(model: ExtractedTable, sort: Sort): number[] {
  const at = new Map(model.rows.map((row, i) => [row, i]));
  return sortRows(model.rows, sort.column, sort.direction).map((row) => at.get(row) as number);
}
