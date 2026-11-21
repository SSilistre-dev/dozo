import { dozoAvatarImageBytes, encodeBotAvatarImage } from "@rakazo/adapters";
import { ClientError } from "@rakazo/core";

/** An uploaded avatar that is not a real picture of the kind it claims to be. */
export class AvatarImageError extends ClientError {
  constructor(options?: ErrorOptions) {
    super("BAD_REQUEST", "Couldn't use that image as an avatar", "avatar_image", options);
  }
}

/**
 * The avatar value to store for one a person sends: a colour or shape as sent, and a new uploaded
 * picture checked and re-encoded by the server. A value the bot already has is kept as it is, so
 * saving other settings never re-encodes the same picture again.
 */
export async function dozoAvatarForSave<T extends string | undefined>(
  sent: T,
  current?: string | null,
): Promise<T> {
  if (!sent || sent === current || !sent.startsWith("data:image/")) return sent;
  const bytes = dozoAvatarImageBytes(sent);
  if (!bytes) throw new AvatarImageError();
  try {
    return (await encodeBotAvatarImage(bytes)) as T;
  } catch (error) {
    throw new AvatarImageError({ cause: error });
  }
}
