import { useLingui } from "@lingui/react/macro";
import type { ChatExportRange } from "@rakazo/contracts";
import { chatExportSince } from "@rakazo/contracts";
import { dozoLocalDay } from "@rakazo/core";
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

export { chatExportSince };
export type ChatExportTarget = { botId: string; chatId?: string } | { groupId: string };

/** A file name from the chat's name, with what file systems refuse taken out. */
export function chatExportFilename(name: string, now: Date): string {
  const base = name.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "chat";
  return `${base}-${dozoLocalDay(now)}.md`;
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
