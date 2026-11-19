import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoSiteSettings, DozoSiteSettingsChange } from "@rakazo/contracts";
import { DOZO_ANNOUNCEMENT_MAX } from "@rakazo/contracts";
import { Button, buttonVariants, Input, Spinner, Switch, toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { useSave, useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";
import { NotFoundPage } from "./NotFound";
import { WindowChrome } from "./WindowChrome";

/** The site settings an admin changes without a deploy. Anyone else sees an unknown address. */
export function DozoAdminSettingsPage() {
  const { t } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  if (me.isPending) return <PageLoading />;
  if (!me.data?.isAdmin) return <NotFoundPage />;
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-1 border-b px-4 py-3">
        <Link
          to="/admin"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="flex-1 px-2 font-medium">
          <Trans>Site settings</Trans>
        </h1>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          <SettingsPanel />
        </div>
      </main>
    </div>
  );
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
    onFailed: (error) => toast.error(errorText(error, t`Could not save the settings`)),
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
  const input: DozoSiteSettingsChange = {
    // Empty follows the environment.
    maxComputersPerUser: limit.trim() === "" ? null : Number(limit),
    announcementEn: en,
    announcementTr: tr,
  };
  const dirty =
    input.maxComputersPerUser !== data.maxComputersPerUser ||
    en !== data.announcementEn ||
    tr !== data.announcementTr;
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
