import { Trans, useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import { Label, Switch } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useId } from "react";
import { SettingsRow } from "../../components/settings/SettingsRows";
import { toastError } from "../../lib/dozo-error-text";
import { queryClient, useQueryUserId, useSave } from "../../lib/query/query";
import { rpc } from "../../lib/query/rpc";

/**
 * The model pool in Models settings: one switch on a connection's page, offered only where the
 * server says two or more of its provider's connections can hand a run over to each other, and the
 * time a resting connection opens again on its row. Read again on the roster signal a change sends.
 */
function usePool() {
  // The pool is the person's, whichever Space is open: read once per user.
  const key = ["dozoModelPool", useQueryUserId()];
  const pool = useQuery({
    queryKey: key,
    queryFn: () => rpc.dozoModelPool.get(),
    refetchOnWindowFocus: "always",
  });
  return { connections: pool.data?.connections, key };
}

/** Reads the pool again; the roster signal carries a pool change. */
export function dozoModelPoolChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: ["dozoModelPool"] });
}

/** The pool switch on a connection's page, when its provider offers one. */
export function DozoModelPoolSwitch({ credentialId }: { credentialId: string }) {
  const { t } = useLingui();
  const switchId = useId();
  const { connections, key } = usePool();
  const save = useSave({
    save: (pooled: boolean, rpc) => rpc.dozoModelPool.set({ credentialId, pooled }),
    stale: [key],
    onFailed: (error) => toastError(t`Could not save`, error),
  });
  const connection = connections?.find((entry) => entry.credentialId === credentialId);
  if (!connection) return null;
  const pooled = save.pending ? Boolean(save.input) : connection.pooled;
  return (
    <div className="mt-6 rounded-xl border border-border" data-testid="dozo-model-pool">
      <SettingsRow
        label={
          <Label htmlFor={switchId} className="text-body font-normal text-foreground">
            <Trans>Use the next connection when one runs out</Trans>
          </Label>
        }
        control={
          <Switch
            id={switchId}
            checked={pooled}
            disabled={save.pending}
            onCheckedChange={(on) => save.run(on)}
          />
        }
      />
    </div>
  );
}

/** A connection row's detail: when it opens again while it rests, else what the row shows. */
export function DozoConnectionDetail({
  credentialId,
  children,
}: {
  credentialId: string;
  children?: ReactNode;
}) {
  const { i18n } = useLingui();
  const { connections } = usePool();
  const opensAt = connections?.find((entry) => entry.credentialId === credentialId)?.opensAt;
  const now = useNow(opensAt ? 60_000 : null);
  const opens = opensAt ? Date.parse(opensAt) : Number.NaN;
  if (!(opens > now)) return <>{children}</>;
  const sameDay = new Date(opens).toDateString() === new Date(now).toDateString();
  const time = new Intl.DateTimeFormat(i18n.locale, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(opens);
  return (
    <span className="shrink-0 text-body-sm text-muted-foreground" data-testid="dozo-opens-at">
      <Trans>Opens at {time}</Trans>
    </span>
  );
}
