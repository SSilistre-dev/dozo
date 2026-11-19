import { useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Moon } from "lucide-react";
import { runsOnUserMachine } from "../../lib/computer-sandbox";
import { toastError } from "../../lib/dozo-error-text";
import { useSave } from "../../lib/query";

/**
 * Puts the bot's computer to sleep from its header, so it stops using computer hours now instead of
 * after its idle wait. The workspace is saved and the next open wakes it. Hidden while a run or a
 * teaching recording uses the computer, and wherever the server would refuse the stop.
 */
export function ComputerSleepButton({
  botId,
  computer,
  busy,
  onRefresh,
  onClose,
}: {
  botId: string;
  computer: ComputerStatus | null;
  /** A run or a teaching recording is using the computer. */
  busy: boolean;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const sleep = useSave({
    save: (_input, rpc) => rpc.computer.stop({ botId }),
    closesScreen: true,
    onSaved: () => {
      onClose();
      return onRefresh();
    },
    onFailed: (error) => toastError(t`Failed to stop`, error),
  });
  if (
    busy ||
    computer?.botId !== botId ||
    computer.state !== "running" ||
    computer.busyBotName ||
    computer.controlledByOther ||
    runsOnUserMachine(computer)
  )
    return null;
  const label = t`Sleep`;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground"
      aria-label={label}
      title={label}
      data-testid="computer-sleep"
      disabled={sleep.pending}
      onClick={() => sleep.run()}
    >
      <Moon size={16} strokeWidth={1.8} />
    </Button>
  );
}
