import { Trans } from "@lingui/react/macro";
import type { BillingStatus } from "@rakazo/contracts";
import { formatFileSize } from "@rakazo/core";

/** The plan's name and how much of its shared space is used; nothing where files have no limit. */
export function DozoSharedSpace({ status }: { status: BillingStatus }) {
  const space = status.sharedSpace;
  if (!space) return null;
  const used = formatFileSize(space.usedBytes);
  const total = formatFileSize(space.limitBytes);
  return (
    <p data-testid="shared-space" className="mt-2 text-body text-muted-foreground">
      {space.plan} ·{" "}
      <Trans>
        {used} of {total} shared space
      </Trans>
    </p>
  );
}
