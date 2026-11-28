import { useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Monitor } from "lucide-react";
import { IconTooltip } from "../../../components/IconTooltip";
import { openDozoSurface } from "../../dozo-surfaces";

/** The sidebar header's way to the computers wall; the wall's code loads when it first opens. */
export function DozoComputersButton() {
  const { t } = useLingui();
  return (
    <IconTooltip label={t`Computers`}>
      <Button
        variant="floating"
        size="icon"
        aria-label={t`Computers`}
        data-testid="computers-wall-trigger"
        onClick={() => openDozoSurface("computers")}
        className="app-no-drag"
      >
        <Monitor className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </Button>
    </IconTooltip>
  );
}
