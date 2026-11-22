import { useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import { useQuery } from "@tanstack/react-query";
import { useQueryUserId } from "../../lib/query";
import { rpc } from "../../lib/rpc";

/**
 * Which of the person's models rest now, after their quota ran out or their key was refused
 * (packages/adapters/src/dozo-model-rests.ts), as a model row's secondary line: when it opens
 * again. Read under the model pool's key, so the roster signal a new rest sends reads it again.
 */
export function useDozoRestNote() {
  const { t, i18n } = useLingui();
  const rests = useQuery({
    queryKey: ["dozoModelPool", "rests", useQueryUserId()],
    queryFn: () => rpc.dozoModelPool.rests(),
    refetchOnWindowFocus: "always",
  }).data?.rests;
  const now = useNow(rests?.length ? 60_000 : null);
  /** "Opens at …" while the model rests on that connection, itself or with the connection. */
  return (credentialId: string | undefined, modelId: string): string | undefined => {
    if (!credentialId || !rests) return undefined;
    const opens = Math.max(
      ...rests
        .filter(
          (rest) =>
            rest.credentialId === credentialId && (rest.modelId === modelId || !rest.modelId),
        )
        .map((rest) => Date.parse(rest.opensAt)),
    );
    if (!(opens > now)) return undefined;
    const sameDay = new Date(opens).toDateString() === new Date(now).toDateString();
    const time = new Intl.DateTimeFormat(i18n.locale, {
      ...(sameDay ? {} : { month: "short", day: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    }).format(opens);
    return t`Opens at ${time}`;
  };
}
