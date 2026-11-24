import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** The longest note a person can send; a report, not a document. */
export const DOZO_FEEDBACK_MAX_CHARS = 4000;
/** How many of the caller's own failed runs a report may name. */
export const DOZO_FEEDBACK_MAX_RUNS = 5;
/** Screenshots a report may carry, each a PNG, JPEG or WebP, and the bytes each and all may hold. */
export const DOZO_FEEDBACK_MAX_IMAGES = 3;
export const DOZO_FEEDBACK_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const DOZO_FEEDBACK_IMAGES_MAX_BYTES = 8 * 1024 * 1024;
/** The longest picture as a data URL: its base64 plus the header, so the server reads no more. */
const IMAGE_DATA_URL_MAX_CHARS = Math.ceil(DOZO_FEEDBACK_IMAGE_MAX_BYTES / 3) * 4 + 40;

/**
 * What the app adds about itself when the person asks for it: which surface and browser they use,
 * nothing they wrote and nothing that names them. Strict, so a client cannot add a field.
 */
export const DozoClientDiagnosticsSchema = z
  .object({
    surface: z.enum(["web", "desktop", "mobile"]),
    userAgent: z.string().max(300),
    language: z.string().max(35),
    timeZone: z.string().max(64),
  })
  .strict();
export type DozoClientDiagnostics = z.infer<typeof DozoClientDiagnosticsSchema>;

/** The server's part of a report: its build and the ids of the caller's latest failed runs. */
export const DozoServerDiagnosticsSchema = /* @__PURE__ */ (() =>
  z.object({
    revision: z.string().nullable(),
    failedRuns: z.array(z.object({ id: Id, at: IsoDate })).max(DOZO_FEEDBACK_MAX_RUNS),
  }))();
export type DozoServerDiagnostics = z.infer<typeof DozoServerDiagnosticsSchema>;

/**
 * Where feedback goes on this server. Absent when the operator set no address. `send`: the server
 * mails it. `save`: no mail provider, so the person saves the report and writes to `address`
 * themselves; the address is only shared then.
 */
export const DozoFeedbackStatusSchema = /* @__PURE__ */ (() =>
  z.object({
    mode: z.enum(["send", "save"]).nullable(),
    address: z.string().nullable(),
    /** The reply address the report carries: the caller's own, or none for a chat-app account. */
    from: z.string().nullable(),
    server: DozoServerDiagnosticsSchema,
  }))();
export type DozoFeedbackStatus = z.infer<typeof DozoFeedbackStatusSchema>;

export const DozoFeedbackSendSchema = /* @__PURE__ */ (() =>
  z.object({
    message: z.string().trim().min(1).max(DOZO_FEEDBACK_MAX_CHARS),
    /** Pictures as `data:image/...;base64,` values; the server checks the bytes and re-encodes. */
    images: z
      .array(z.string().max(IMAGE_DATA_URL_MAX_CHARS))
      .max(DOZO_FEEDBACK_MAX_IMAGES)
      .optional(),
    /** Only when the person chose to include diagnostics, as the preview showed them. */
    diagnostics: z
      .object({
        client: DozoClientDiagnosticsSchema,
        /** The failed runs the preview listed; the server keeps only the caller's own. */
        runIds: z.array(Id).max(DOZO_FEEDBACK_MAX_RUNS),
      })
      .optional(),
  }))();
export type DozoFeedbackSend = z.infer<typeof DozoFeedbackSendSchema>;

/** What a report adds about the app and server when the person includes diagnostics. */
export type DozoFeedbackDiagnostics = DozoClientDiagnostics & DozoServerDiagnostics;

/**
 * The lines after the note: who it is from and, when included, the diagnostics. The preview shows
 * exactly these, and the server writes them under the note, so what is seen is what is sent.
 */
export function dozoFeedbackFooter(
  from: string | null,
  diagnostics: DozoFeedbackDiagnostics | null,
  images = 0,
): string {
  const lines = ["--", `From: ${from ?? "(no reply address)"}`];
  if (images > 0) lines.push(`Images: ${images}`);
  if (diagnostics) {
    const runs = diagnostics.failedRuns.map((run) => `${run.id} (${run.at})`).join(", ");
    lines.push(
      `Surface: ${diagnostics.surface}`,
      `Browser: ${diagnostics.userAgent}`,
      `Language: ${diagnostics.language}`,
      `Time zone: ${diagnostics.timeZone}`,
      `Server revision: ${diagnostics.revision ?? "unknown"}`,
      `Failed runs: ${runs || "none"}`,
    );
  }
  return lines.join("\n");
}

/** The whole report as plain text: the note, then its footer. */
export function dozoFeedbackText(
  message: string,
  from: string | null,
  diagnostics: DozoFeedbackDiagnostics | null,
  images = 0,
): string {
  return `${message.trim()}\n\n${dozoFeedbackFooter(from, diagnostics, images)}\n`;
}

export const dozoFeedbackContract = /* @__PURE__ */ (() => ({
  status: oc.output(DozoFeedbackStatusSchema),
  send: oc.input(DozoFeedbackSendSchema).output(z.object({ sent: z.literal(true) })),
}))();
