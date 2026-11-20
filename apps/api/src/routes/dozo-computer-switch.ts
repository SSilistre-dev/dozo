import type { AdapterContext } from "@rakazo/adapter-kit";
import type { ComputerMoveDeps } from "@rakazo/adapters";
import { moveBotComputerFiles } from "@rakazo/adapters";
import type { Bot } from "@rakazo/contracts";

const COMPUTER_FIELDS = {
  id: true,
  homeKey: true,
  kind: true,
  providerRef: true,
  scope: true,
} as const;

/**
 * Switch the bot's computer and move its files and browser sign-ins with it. The switch counts
 * only once they have moved: when they cannot, it is undone and the refusal says why.
 */
export async function switchBotComputerWithFiles(
  deps: ComputerMoveDeps,
  input: { botId: string; fromComputerId: string; context: AdapterContext },
  switchTo: () => Promise<Bot>,
  switchBack: () => Promise<unknown>,
): Promise<Bot> {
  const from = await deps.prisma.computer.findUniqueOrThrow({
    where: { id: input.fromComputerId },
    select: COMPUTER_FIELDS,
  });
  const updated = await switchTo();
  try {
    const to = await deps.prisma.computer.findFirstOrThrow({
      where: { bots: { some: { id: input.botId } } },
      select: COMPUTER_FIELDS,
    });
    await moveBotComputerFiles(deps, { botId: input.botId, from, to }, input.context);
  } catch (error) {
    await switchBack();
    throw error;
  }
  return updated;
}
