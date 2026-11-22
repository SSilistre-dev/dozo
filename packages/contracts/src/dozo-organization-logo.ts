import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "./ids.js";

/** The largest picture a person can send as a logo: about 2 MB of image as a data URL. */
export const DOZO_ORGANIZATION_LOGO_UPLOAD_MAX_LENGTH = 2_800_000;

/** The `code` a logo the server cannot use as a picture is refused with (BAD_REQUEST). */
export const DOZO_ORGANIZATION_LOGO_ERROR = "organization_logo";

/** The organization a Space belongs to, as its members see it in the sidebar. */
export const DozoOrganizationMarkSchema = /* @__PURE__ */ z.object({
  name: z.string(),
  /** The server's own `data:image/webp;base64,` picture, or null without a logo. */
  logo: z.string().nullable(),
});
export type DozoOrganizationMark = z.infer<typeof DozoOrganizationMarkSchema>;

/** One organization's logo for its settings, and whether the caller may change it. */
export const DozoOrganizationLogoSchema = /* @__PURE__ */ z.object({
  logo: z.string().nullable(),
  canManage: z.boolean(),
});
export type DozoOrganizationLogo = z.infer<typeof DozoOrganizationLogoSchema>;

export const dozoOrganizationLogoContract = /* @__PURE__ */ (() => ({
  /** The logo of the organization the current Space belongs to, for any member of that Space. */
  mark: oc.output(DozoOrganizationMarkSchema),
  /** A member of the organization (not a guest of one of its Spaces). */
  get: oc.input(z.object({ organizationId: Id })).output(DozoOrganizationLogoSchema),
  /** The owner only. A picture is checked and re-encoded by the server; null removes it. */
  set: oc
    .input(
      z.object({
        organizationId: Id,
        logo: z
          .string()
          .startsWith("data:image/")
          .max(DOZO_ORGANIZATION_LOGO_UPLOAD_MAX_LENGTH)
          .nullable(),
      }),
    )
    .output(DozoOrganizationLogoSchema),
}))();
