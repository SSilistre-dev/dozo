import { Trans, useLingui } from "@lingui/react/macro";
import { DOZO_ORGANIZATION_LOGO_UPLOAD_MAX_LENGTH } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { SettingsRow } from "../components/SettingsRows";
import { useSave, useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";
import { DozoOrganizationLogoTile } from "./shell/dozo-organization-mark";

/** The pictures the server can use; it checks the bytes and draws the stored logo itself. */
const LOGO_TYPES = "image/png,image/jpeg,image/webp,image/gif";

/** Reads a chosen file as the data URL the server takes, or null when it cannot be one. */
export function readLogoFile(file: File): Promise<string | null> {
  if (!LOGO_TYPES.split(",").includes(file.type)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      resolve(value && value.length <= DOZO_ORGANIZATION_LOGO_UPLOAD_MAX_LENGTH ? value : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * The organization's logo in its settings: its owner or an admin uploads or removes it, anyone
 * else in the organization only sees it. Without a logo and the right to add one there is no row.
 */
export function DozoOrganizationLogoRow({ organizationId }: { organizationId: string }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const input = { organizationId };
  const read = useQuery(queries.dozoOrganizationLogo.get.queryOptions({ input })).data;
  const file = useRef<HTMLInputElement>(null);
  const [unusable, setUnusable] = useState(false);
  const save = useSave({
    save: (logo: string | null, rpc) => rpc.dozoOrganizationLogo.set({ organizationId, logo }),
    stale: [queries.dozoOrganizationLogo.key()],
  });
  if (!read || (!read.logo && !read.canManage)) return null;
  const error = unusable
    ? t`Couldn't use that image as a logo`
    : save.error && errorText(save.error);
  return (
    <SettingsRow
      label={<Trans>Logo</Trans>}
      control={
        <>
          {read.logo ? <DozoOrganizationLogoTile logo={read.logo} name="" /> : null}
          {read.canManage ? (
            <>
              <input
                ref={file}
                type="file"
                accept={LOGO_TYPES}
                className="hidden"
                data-testid="organization-logo-file"
                onChange={(event) => {
                  const chosen = event.target.files?.[0];
                  event.target.value = "";
                  if (!chosen) return;
                  void readLogoFile(chosen).then((logo) => {
                    setUnusable(!logo);
                    if (logo) save.run(logo);
                  });
                }}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={save.pending}
                onClick={() => file.current?.click()}
              >
                <Trans>Upload</Trans>
              </Button>
              {read.logo ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={save.pending}
                  onClick={() => {
                    setUnusable(false);
                    save.run(null);
                  }}
                >
                  <Trans>Remove</Trans>
                </Button>
              ) : null}
            </>
          ) : null}
        </>
      }
    >
      {error ? (
        <p role="alert" className="pt-2 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsRow>
  );
}
