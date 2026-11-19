import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoSiteSettings, DozoSiteSettingsChange } from "@rakazo/contracts";
import { DOZO_ANNOUNCEMENT_MAX } from "@rakazo/contracts";
import { Button, Input, Spinner, Switch } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { errorText, toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query";

/**
 * The admin page's site settings section, at `/admin/settings`: what an admin changes without a
 * deploy. The admin page around it checks who may see it.
 */
export function DozoAdminSettingsPage() {
  return <SettingsPanel />;
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 border-b py-2 text-body">
      <span>{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function SettingsPanel() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  // Read once, and again whenever the window comes back: nothing here is polled.
  const settings = useQuery({
    ...queries.dozoSiteSettings.get.queryOptions(),
    refetchOnWindowFocus: "always",
  });
  const change = useSave({
    save: (input: DozoSiteSettingsChange, rpc) => rpc.dozoSiteSettings.update(input),
    stale: [queries.dozoSiteSettings.get.key(), queries.dozoSiteSettings.announcement.key()],
    onFailed: (error) => toastError(t`Could not save the settings`, error),
  });

  if (settings.isPending)
    return (
      <div className="grid place-items-center py-10">
        <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
      </div>
    );
  if (settings.isError)
    return (
      <div role="alert" className="flex items-center gap-3 text-body text-destructive">
        {errorText(settings.error, t`Couldn't load the settings`)}
        <Button variant="outline" size="sm" onClick={() => void settings.refetch()}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    );

  const data = settings.data;
  const signupsOpen = data.signupsOpen ?? data.environment.signupsOpen;
  const memoryGb = Math.round((data.memoryBudgetGb ?? 0) * 10) / 10;
  return (
    <>
      <Row label={<Trans>Sign-up open</Trans>}>
        {data.signupsOpen === null ? null : (
          <Button
            variant="ghost"
            size="sm"
            disabled={change.pending}
            onClick={() => change.run({ signupsOpen: null })}
          >
            <Trans>Reset</Trans>
          </Button>
        )}
        <Switch
          aria-label={t`Sign-up open`}
          checked={signupsOpen}
          disabled={change.pending}
          onCheckedChange={(checked) => change.run({ signupsOpen: checked })}
        />
      </Row>
      {data.memoryBudgetGb === null ? null : (
        <Row label={<Trans>Computer memory</Trans>}>
          <span className="text-muted-foreground">
            <Trans>{memoryGb} GB</Trans>
          </span>
        </Row>
      )}
      {/* Keyed by what was saved, so a save or another admin's change resets the fields. */}
      <SettingsForm
        key={[data.maxComputersPerUser, data.announcementEn, data.announcementTr].join("\n")}
        data={data}
        pending={change.pending}
        onSave={(input) => change.run(input)}
      />
    </>
  );
}

function SettingsForm({
  data,
  pending,
  onSave,
}: {
  data: DozoSiteSettings;
  pending: boolean;
  onSave: (input: DozoSiteSettingsChange) => void;
}) {
  const { t } = useLingui();
  const [limit, setLimit] = useState(data.maxComputersPerUser?.toString() ?? "");
  const [en, setEn] = useState(data.announcementEn);
  const [tr, setTr] = useState(data.announcementTr);
  const environmentLimit = data.environment.maxComputersPerUser;
  // Empty follows the environment.
  const maxComputersPerUser = limit.trim() === "" ? null : Number(limit);
  // Only what this admin edited, so a save never puts back what another admin changed meanwhile.
  const input: DozoSiteSettingsChange = {
    ...(maxComputersPerUser !== data.maxComputersPerUser ? { maxComputersPerUser } : {}),
    ...(en !== data.announcementEn ? { announcementEn: en } : {}),
    ...(tr !== data.announcementTr ? { announcementTr: tr } : {}),
  };
  const dirty = Object.keys(input).length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(input);
  };
  return (
    <form onSubmit={submit}>
      <Row label={<Trans>Computers per person</Trans>}>
        <Input
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          className="w-28"
          aria-label={t`Computers per person`}
          placeholder={environmentLimit === 0 ? t`No limit` : String(environmentLimit)}
          value={limit}
          onChange={(event) => setLimit(event.target.value)}
        />
      </Row>
      <div className="space-y-2 border-b py-3">
        <span className="text-body">
          <Trans>Announcement</Trans>
        </span>
        <Input
          aria-label={t`Announcement in English`}
          placeholder="English"
          maxLength={DOZO_ANNOUNCEMENT_MAX}
          value={en}
          onChange={(event) => setEn(event.target.value)}
        />
        <Input
          aria-label={t`Announcement in Turkish`}
          placeholder="Türkçe"
          maxLength={DOZO_ANNOUNCEMENT_MAX}
          value={tr}
          onChange={(event) => setTr(event.target.value)}
        />
      </div>
      {dirty ? (
        <div className="flex justify-end pt-3">
          <Button type="submit" size="sm" disabled={pending}>
            <Trans>Save</Trans>
          </Button>
        </div>
      ) : null}
    </form>
  );
}
