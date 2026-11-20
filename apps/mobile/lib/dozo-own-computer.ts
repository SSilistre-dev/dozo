import { t } from "@lingui/core/macro";
import type { Bot, ComputerMode } from "@rakazo/contracts";
import { ownComputerNote } from "@rakazo/contracts";
import { knownServerText, planLimitCopy } from "@rakazo/i18n/run-error";
import { useQuery } from "@tanstack/react-query";
import { Alert } from "react-native";
import { rpcQuery } from "./query";

/**
 * The line under the bot's Own computer switch (`ownComputerNote`): on a plan with no computer,
 * why the switch is off and cannot be turned on; on a Team Computer, that it is shared. The switch
 * moves the bot's files, so only its maker or the Space's owner may use it: anyone else sees it
 * read-only, with the server's reason.
 */
export function useOwnComputerSwitch(
  mode: ComputerMode,
  bot: Pick<Bot, "spaceId" | "userId"> | null,
): {
  detail: string | undefined;
  disabled: boolean;
} {
  const billing = useQuery(rpcQuery("billing/status")).data;
  const me = useQuery(rpcQuery("me")).data;
  const notMaker = Boolean(bot?.userId && me && bot.userId !== me.userId);
  const members = useQuery({
    ...rpcQuery("spaces/members/list", { spaceId: bot?.spaceId ?? "" }),
    enabled: notMaker,
  }).data;
  if (notMaker && members?.canManage !== true) {
    return {
      detail: knownServerText("Only the space owner can do that") ?? undefined,
      disabled: true,
    };
  }
  const note = ownComputerNote(mode, billing, planLimitCopy());
  if (note === "shared") {
    return {
      detail: t`Shared with this Space's other bots, files and sign-ins included.`,
      disabled: false,
    };
  }
  return { detail: note?.text, disabled: note !== null };
}

/** Ask before switching: the bot's files and browser sign-ins move with it. */
export function confirmComputerMove(mode: ComputerMode, apply: (mode: ComputerMode) => void) {
  Alert.alert(
    mode === "dedicated"
      ? t`This bot's files and browser sign-ins move to its own computer and are removed from the Team Computer.`
      : t`This bot's files and browser sign-ins move to the Team Computer, where this Space's other bots can open them.`,
    undefined,
    [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Move`, onPress: () => apply(mode) },
    ],
  );
}
