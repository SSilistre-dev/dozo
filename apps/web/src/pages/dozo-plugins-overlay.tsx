import { Trans, useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { Suspense } from "react";
import { lazyOverlay } from "../components/ErrorBoundary";
import { preloadPluginsOverlay, warmPluginsOverlay } from "./dozo-plugins-overlay-chunk";
import type { PluginsOverlay as LoadedPluginsOverlay } from "./PluginsOverlay";
import { IntegrationRowsSkeleton } from "./plugins/dozo-integrations-skeleton";

type PluginsOverlayProps = ComponentProps<typeof LoadedPluginsOverlay>;

/** Long enough for the shell's own first reads to go out before the overlay's code is fetched. */
export const PRELOAD_AFTER_MS = 1500;

/** Fetches the overlay's code once the shell has settled, so opening it draws at once. */
export function usePreloadPluginsOverlay() {
  useTimeout(warmPluginsOverlay, PRELOAD_AFTER_MS);
}

const LazyPluginsOverlay = lazyOverlay(preloadPluginsOverlay);

/** Drawn on the click while the overlay's code is still on its way. */
function PluginsOverlaySkeleton({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} size="2xl" className="bg-card">
        <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
          <DialogTitle className="text-heading2 text-foreground">
            <Trans>Integrations</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close integrations`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
        <div className="px-8 pt-4">
          <Input
            disabled
            aria-label={t`Search apps`}
            placeholder={t`Search apps`}
            className="h-11 rounded-xl px-4 md:text-body-lg"
          />
        </div>
        <div className="flex-1 overflow-hidden px-8 py-6">
          <IntegrationRowsSkeleton label={t`Loading integrations…`} rows={10} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Upstream's integrations overlay, with a placeholder dialog instead of nothing while it loads. */
export function PluginsOverlay(props: PluginsOverlayProps) {
  return (
    <Suspense fallback={<PluginsOverlaySkeleton onClose={props.onClose} />}>
      <LazyPluginsOverlay {...props} />
    </Suspense>
  );
}
