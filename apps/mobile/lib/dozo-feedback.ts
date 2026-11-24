import type { DozoClientDiagnostics } from "@rakazo/contracts";
import { DOZO_FEEDBACK_IMAGE_MAX_BYTES, DOZO_FEEDBACK_MAX_IMAGES } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Platform } from "react-native";
import { pickFromLibrary } from "./pick-attachments";
import { queryClient, rpcQuery } from "./query";
import { deviceTimeZone } from "./routine";

/** What the app says about itself: surface, system, language and time zone, nothing else. */
export function mobileDiagnostics(): DozoClientDiagnostics {
  return {
    surface: "mobile",
    userAgent: `Dozo ${Platform.OS} ${Platform.Version}`.slice(0, 300),
    language: Intl.DateTimeFormat().resolvedOptions().locale.slice(0, 35),
    timeZone: (deviceTimeZone() ?? "UTC").slice(0, 64),
  };
}

/** The first line of a report from a message's menu: which message, as the operator finds it. */
export function reportLine(threadId: string, messageId: string): string {
  return `Reported message ${messageId} in chat ${threadId}`;
}

/** Where feedback goes on this server; nothing while it is loading or not set up. */
export function useFeedbackStatus() {
  return useQuery({ ...rpcQuery("dozoFeedback/status"), refetchOnMount: "always" }, queryClient)
    .data;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** A picture a person added to a report: its name, and its content as a data URL. */
export interface FeedbackImage {
  name: string;
  url: string;
}

/**
 * Pictures from the photo library, through the picker that attachments use (no new native code).
 * Only PNG, JPEG and WebP within the size of a picture are kept; `refused` is set when the person
 * chose something that was left out. The server checks the bytes again.
 */
export async function pickFeedbackImages(
  existing: number,
): Promise<{ images: FeedbackImage[]; refused: boolean }> {
  const picked = await pickFromLibrary(
    existing,
    DOZO_FEEDBACK_IMAGE_MAX_BYTES,
    DOZO_FEEDBACK_MAX_IMAGES,
  );
  const usable = picked.attachments.filter((file) => IMAGE_TYPES.has(file.mimeType));
  return {
    images: usable.map((file) => ({
      name: file.name,
      url: `data:${file.mimeType};base64,${file.contentBase64}`,
    })),
    refused: picked.skipped.length > 0 || usable.length < picked.attachments.length,
  };
}
