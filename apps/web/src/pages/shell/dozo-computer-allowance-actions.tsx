import { Trans } from "@lingui/react/macro";
import { Button, buttonVariants } from "@rakazo/ui-web";
import { Link, useSearchParams } from "react-router-dom";
import { searchString, withShellOverlay } from "./shell-overlay-url";

/**
 * The actions under a computer refused for hours: Upgrade first, and for a plan with no computer
 * the member's own devices, where a computer of their own is connected.
 */
export function ComputerAllowanceActions({
  upgrade,
  ownDevice,
  onUpgrade,
}: {
  upgrade: string | null;
  ownDevice: boolean;
  onUpgrade: () => void;
}) {
  const [params] = useSearchParams();
  const devices = {
    search: searchString(
      withShellOverlay(params, { kind: "settings", section: "computer", spaceId: null }),
    ),
  };
  return (
    <>
      {upgrade ? <Button size="sm" onClick={onUpgrade}>{upgrade}</Button> : null}
      {ownDevice ? (
        <Link to={devices} className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <Trans>Your devices</Trans>
        </Link>
      ) : null}
    </>
  );
}
