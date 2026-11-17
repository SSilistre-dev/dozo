import type { LogoAvatarActivity } from "@rakazo/core";
import { botLookWithShape, dozoCharacterForLook } from "@rakazo/core";
import type { ComponentProps } from "react";
import { memo } from "react";
import type { BotAvatarProps, BotShapePreview as UpstreamBotShapePreview } from "./bot-avatar.js";
import { parseBotAvatar, BotAvatar as UpstreamBotAvatar } from "./bot-avatar.js";
import { useBotAvatarActivity } from "./bot-avatar-activity.js";
import type { DozoAvatarState } from "./dozo-avatar.js";
import { DozoAvatar } from "./dozo-avatar.js";
import { DozoLogo } from "./dozo-logo.js";
import { cn } from "./lib/utils.js";

/**
 * The fork's stand-ins for upstream's avatar components: same names and props, drawn as Dozo
 * characters. Anchored rules point the package index and the group avatar here, so every surface
 * that shows a bot follows. Everything else the upstream module exports passes through unchanged.
 */
export * from "./bot-avatar.js";

function stateOf(activity: LogoAvatarActivity): DozoAvatarState {
  if (activity === "waiting") return "waiting";
  return activity === "idle" || activity === "error" ? "idle" : "working";
}

/** A bot's avatar. A saved photo stays the photo; every drawn avatar is a Dozo character. */
export const BotAvatar = memo(function BotAvatar(props: BotAvatarProps) {
  const { color, activity, size = 36, status, identity = "", className } = props;
  const live = useBotAvatarActivity(identity, status);
  if (parseBotAvatar(color).isImage) return <UpstreamBotAvatar {...props} />;
  const seed = identity || color || "bot";
  return (
    <DozoAvatar
      seed={seed}
      character={dozoCharacterForLook(seed, color)}
      size={size}
      state={stateOf(activity ?? live)}
      className={className}
    />
  );
});

/** One choice in the avatar editor: the character that shape or identity is drawn as. */
export function BotShapePreview({
  shapeIndex,
  identity,
  label,
  color,
  selected,
  onClick,
}: ComponentProps<typeof UpstreamBotShapePreview>) {
  const look = shapeIndex === undefined ? color : botLookWithShape(color, shapeIndex);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label ?? dozoCharacterForLook(identity ?? "preview", look)}
      aria-pressed={selected ?? false}
      className={cn(
        "relative flex size-11 items-center justify-center rounded-xl transition-transform hover:scale-105 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
        selected ? "bg-accent ring-2 ring-primary ring-offset-2 ring-offset-popover" : "",
      )}
    >
      <BotAvatar color={look} identity={identity ?? "preview"} size={32} />
    </button>
  );
}

/**
 * What stands at the door (sign-in and sign-up): the Dozo logo, not a bot. Bots live inside the
 * app. Upstream's props are accepted so its call site stays as it is; a logo has no colour to
 * pick, no size of a bot's and no activity, so only the label and the class are used.
 */
export function LogoAvatar({
  label,
  className,
}: {
  activity?: LogoAvatarActivity;
  size?: number;
  avatarValue?: string;
  identity?: string;
  label?: string;
  motion?: boolean;
  className?: string;
}) {
  return <DozoLogo title={label} className={className} />;
}

/** The text wordmark with its seal dot; the styles are in dozo-shell.css. */
export function Wordmark({ className }: { className?: string }) {
  return <span className={cn("dozo-wordmark", className)}>dozo</span>;
}
