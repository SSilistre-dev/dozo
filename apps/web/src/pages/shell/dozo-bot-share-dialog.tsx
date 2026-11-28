import { Trans, useLingui } from "@lingui/react/macro";
import { errorCode } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  Input,
  Spinner,
  toast,
  writeClipboard,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { SectionLoadFailed } from "../../components/ErrorBoundary";
import { toastError } from "../../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { DozoBotDefinition } from "../dozo-bot-definition";
import type { DozoSurfaceProps } from "../dozo-surfaces";
import { SwitchRow } from "./bots/bot-settings-sections";

/**
 * The owner's review before a bot's link exists: the exact text that becomes public, an uploaded
 * picture only when ticked, and the one action that publishes it. A live link shows when it
 * expires and can be revoked; publishing again replaces it.
 */
export function DozoBotShareDialog({ params, onClose }: DozoSurfaceProps) {
  const botId = params.botId ?? "";
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const [includePicture, setIncludePicture] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const preview = useQuery({
    ...queries.dozoBotShares.preview.queryOptions({ input: { botId, includePicture } }),
    staleTime: 0,
  });
  const statusRead = queries.dozoBotShares.status.queryOptions({ input: { botId } });
  const link = useQuery(statusRead).data?.link ?? null;
  const publish = useSave({
    save: (fingerprint: string, rpc) =>
      rpc.dozoBotShares.publish({ botId, includePicture, fingerprint }),
    stale: [statusRead.queryKey],
    onSaved: (made) => setUrl(made.url),
    onFailed: (error) => {
      // The bot changed since this was shown: show what publishing would take now.
      if (errorCode(error) === "BOT_SHARE_CHANGED") void preview.refetch();
      toastError(t`Could not share`, error);
    },
  });
  const revoke = useSave({
    save: (_: undefined, rpc) => rpc.dozoBotShares.revoke({ botId }),
    stale: [statusRead.queryKey],
    onSaved: () => setUrl(null),
    onFailed: (error) => toastError(t`Could not revoke`, error),
  });
  const copy = async (text: string) => {
    if (await writeClipboard(text)) toast(t`Copied`);
    else toastError(t`Could not copy`);
  };
  const shown = preview.data;
  const tooLarge = errorCode(preview.error) === "BOT_SHARE_TOO_LARGE";
  const date = link ? i18n.date(new Date(link.expiresAt), { dateStyle: "medium" }) : "";

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogTitle>
          <Trans>Share link</Trans>
        </DialogTitle>
        {shown ? (
          <>
            <DozoBotDefinition
              bot={{
                ...shown.definition,
                color: shown.definition.avatar.color,
                routines: shown.definition.routines.map((routine) => ({
                  name: routine.name,
                  schedule: routine.crons.join(", "),
                })),
              }}
            />
            {shown.hasPicture ? (
              <SwitchRow
                id={`bot-share-picture-${botId}`}
                label={<Trans>Include picture</Trans>}
                checked={includePicture}
                disabled={publish.pending}
                onChange={setIncludePicture}
              />
            ) : null}
            <p className="text-body-sm text-muted-foreground">
              <Trans>Anyone with the link can see this and make their own copy.</Trans>
            </p>
          </>
        ) : tooLarge ? (
          <p className="text-body">
            <Trans>This bot is too large to share.</Trans>
          </p>
        ) : preview.isError ? (
          <SectionLoadFailed />
        ) : (
          <Spinner />
        )}
        {url ? (
          <div className="flex gap-2">
            <Input readOnly value={url} aria-label={t`Link`} />
            <Button variant="secondary" onClick={() => void copy(url)}>
              <Trans>Copy link</Trans>
            </Button>
          </div>
        ) : null}
        <DialogFooter className="items-center">
          {link ? (
            <>
              <span className="mr-auto text-body-sm text-muted-foreground">
                <Trans>Link expires {date}</Trans>
              </span>
              <Button
                variant="destructive-secondary"
                disabled={revoke.pending}
                onClick={() => revoke.run(undefined)}
              >
                <Trans>Revoke link</Trans>
              </Button>
            </>
          ) : null}
          <Button
            disabled={!shown || publish.pending}
            onClick={() => shown && publish.run(shown.fingerprint)}
          >
            {link ? <Trans>Create new link</Trans> : <Trans>Create link</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
