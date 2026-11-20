import { useLingui } from "@lingui/react/macro";
import {
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  toast,
  writeClipboard,
} from "@rakazo/ui-web";
import { Copy, Download, FileText } from "lucide-react";
import { useState } from "react";
import { downloadArtifactBytes } from "../../lib/artifact-open";
import { toastError } from "../../lib/dozo-error-text";
import type { createSpaceRpc } from "../../lib/rpc";

export type ChatExportRange = "all" | "today" | "week" | "month";
export type ChatExportTarget = { botId: string } | { groupId: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The first moment a range covers, in the reader's own day; nothing for the whole chat. */
export function chatExportSince(range: ChatExportRange, now: Date): string | undefined {
  if (range === "all") return undefined;
  if (range === "today") {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.toISOString();
  }
  return new Date(now.getTime() - (range === "week" ? 7 : 30) * DAY_MS).toISOString();
}

/** A file name from the chat's name, with what file systems refuse taken out. */
export function chatExportFilename(name: string, now: Date): string {
  const base = name.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "chat";
  return `${base}-${now.toISOString().slice(0, 10)}.md`;
}

export type DozoChatExportMenuProps = {
  rpc: ReturnType<typeof createSpaceRpc>;
  target: ChatExportTarget;
  name: string;
  onClose: () => void;
};

/**
 * The roster menu's Export item: the server renders the chat as Markdown, as the caller may read
 * it, and the client copies or saves the answer.
 */
export function DozoChatExportMenu({ rpc, target, name, onClose }: DozoChatExportMenuProps) {
  const { t } = useLingui();
  const [range, setRange] = useState<ChatExportRange>("all");

  async function run(action: "copy" | "download") {
    onClose();
    const now = new Date();
    try {
      const result = await rpc.dozoChatExport.markdown({
        ...target,
        since: chatExportSince(range, now),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (action === "download") {
        downloadArtifactBytes(
          chatExportFilename(name, now),
          "text/markdown",
          new TextEncoder().encode(result.markdown),
        );
      } else if (!(await writeClipboard(result.markdown))) {
        toastError(t`Could not copy`);
        return;
      }
      if (result.truncated) toast(t`Earlier messages were left out`);
      else if (action === "copy") toast(t`Copied`);
    } catch (error) {
      toastError(t`Could not export`, error);
    }
  }

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <FileText />
        {t`Export`}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="min-w-[200px]">
        <ContextMenuRadioGroup
          value={range}
          onValueChange={(value) => setRange(value as ChatExportRange)}
        >
          <ContextMenuRadioItem value="all">{t`Whole chat`}</ContextMenuRadioItem>
          <ContextMenuRadioItem value="today">{t`Today`}</ContextMenuRadioItem>
          <ContextMenuRadioItem value="week">{t`Last 7 days`}</ContextMenuRadioItem>
          <ContextMenuRadioItem value="month">{t`Last 30 days`}</ContextMenuRadioItem>
        </ContextMenuRadioGroup>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void run("copy")}>
          <Copy />
          {t`Copy as Markdown`}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => void run("download")}>
          <Download />
          {t`Download Markdown`}
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
