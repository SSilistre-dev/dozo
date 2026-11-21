import { useLingui } from "@lingui/react/macro";
import type { DozoUsageGroup, DozoUsageGrouping, UsageSummary } from "@rakazo/contracts";
import { dozoLocalDay } from "@rakazo/core";
import { Button, ToggleGroup, ToggleGroupItem } from "@rakazo/ui-web";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@rakazo/ui-web/components/ui/table";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import type { RefObject } from "react";
import { useState } from "react";
import { downloadArtifactBytes } from "../lib/artifact-open";
import { toastError } from "../lib/dozo-error-text";
import { useSpaceQueries } from "../lib/query";
import { UsageSettingsPanel as UpstreamUsageSettingsPanel } from "../pages/AccountSettingsOverlay";
import { IconTooltip } from "./IconTooltip";

/**
 * Settings > Usage: upstream's totals, then the caller's spend grouped by model, bot or routine,
 * which replaces upstream's per-model table. The server groups and renders the CSV, from the
 * caller's own records only.
 */
export function DozoUsageSettingsPanel({
  usage,
  panelRef,
}: {
  usage?: UsageSummary | null;
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      <UpstreamUsageSettingsPanel usage={usage && { ...usage, models: [] }} panelRef={panelRef} />
      {usage?.models?.length ? <DozoUsageBreakdown /> : null}
    </>
  );
}

export function DozoUsageBreakdown() {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const [by, setBy] = useState<DozoUsageGrouping>("model");
  const { data } = useQuery({
    ...queries.dozoUsage.breakdown.queryOptions({ input: { by } }),
    placeholderData: keepPreviousData,
  });
  const count = new Intl.NumberFormat(i18n.locale);
  const usd = new Intl.NumberFormat(i18n.locale, { style: "currency", currency: "USD" });
  const number = (value: number | null) => (value == null ? "—" : count.format(value));
  const cost = (value: number | null) =>
    value == null ? "—" : value > 0 && value < 0.01 ? `<${usd.format(0.01)}` : usd.format(value);
  const groupings: Array<[DozoUsageGrouping, string]> = [
    ["model", t`Model`],
    ["bot", t`Bot`],
    ["routine", t`Routine`],
  ];
  const name = (group: DozoUsageGroup) => {
    if (group.state === "unknown") return t`Unknown`;
    if (group.state === "none") return by === "bot" ? t`No bot` : t`No routine`;
    return group.name ?? "—";
  };
  const detail = (group: DozoUsageGroup) => (group.state === "deleted" ? t`Deleted` : group.detail);

  async function download() {
    try {
      const { csv } = await queries.dozoUsage.csv.call({ by });
      const day = dozoLocalDay(new Date());
      downloadArtifactBytes(`usage-${by}-${day}.csv`, "text/csv", new TextEncoder().encode(csv));
    } catch (error) {
      toastError(t`Could not export`, error);
    }
  }

  return (
    <div data-testid="usage-breakdown" className="mt-4 rounded-xl border border-border px-2 pt-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <ToggleGroup
          aria-label={t`Group by`}
          value={[by]}
          onValueChange={([next]) => {
            if (next) setBy(next as DozoUsageGrouping);
          }}
          spacing={1}
          className="w-fit rounded-lg bg-muted p-1"
        >
          {groupings.map(([value, label]) => (
            <ToggleGroupItem
              key={value}
              value={value}
              className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
            >
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <IconTooltip label={t`Download CSV`}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t`Download CSV`}
            onClick={() => void download()}
          >
            <Download />
          </Button>
        </IconTooltip>
      </div>
      {data && data.length > 0 ? (
        <Table className="text-body">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {/* The selected grouping above already names this column on screen. */}
              <TableHead>
                <span className="sr-only">{groupings.find(([value]) => value === by)?.[1]}</span>
              </TableHead>
              <TableHead className="text-right text-muted-foreground">
                {t`Calls`}
              </TableHead>
              <TableHead className="text-right text-muted-foreground">
                {t`Input`}
              </TableHead>
              <TableHead className="text-right text-muted-foreground">
                {t`Output`}
              </TableHead>
              <TableHead className="text-right text-muted-foreground">
                {t`Cost`}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((group) => (
              <TableRow key={group.key} className="hover:bg-transparent">
                <TableCell>
                  <div
                    className={group.state === "live" ? "text-foreground" : "text-muted-foreground"}
                  >
                    {name(group)}
                  </div>
                  {detail(group) ? (
                    <div className="text-label text-muted-foreground">{detail(group)}</div>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {number(group.modelCalls)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {number(group.inputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {number(group.outputTokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{cost(group.costUsd)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}
