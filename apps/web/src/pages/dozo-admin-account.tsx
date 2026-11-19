import { Trans, useLingui } from "@lingui/react/macro";
import { formatFileSize } from "@rakazo/core";
import { Badge, Button, buttonVariants, Input, SectionHeading, toast } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useSave, useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";
import { DozoPlanAction } from "./dozo-admin-plan";
import { Row, Rows } from "./dozo-admin-rows";

type Change =
  | { kind: "rename"; name: string }
  | { kind: "suspend"; suspended: boolean }
  | { kind: "sessions" }
  | { kind: "delete" };

type Confirm = "rename" | "suspend" | "sessions" | "delete";

/** One member in full at `/admin/users/<id>`, with what an admin can do to the account. */
export function DozoAdminAccount({ ownId }: { ownId: string }) {
  const { userId = "" } = useParams();
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const navigate = useNavigate();
  // Read once, and again whenever the window comes back: nothing here is polled.
  const account = useQuery({
    ...queries.dozoAdmin.user.queryOptions({ input: { userId } }),
    refetchOnWindowFocus: "always",
  });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [name, setName] = useState("");
  const change = useSave({
    save: async (input: Change, rpc) => {
      if (input.kind === "rename") await rpc.dozoAdmin.rename({ userId, name: input.name });
      else if (input.kind === "sessions") await rpc.dozoAdmin.endSessions({ userId });
      else if (input.kind === "delete") await rpc.dozoAdmin.deleteUser({ userId });
      else await rpc.dozoAdmin.setSuspended({ userId, suspended: input.suspended });
    },
    // A deleted account is not read again: the page leaves it.
    stale: (input) =>
      input.kind === "delete"
        ? [queries.dozoAdmin.users.key()]
        : [queries.dozoAdmin.user.key(), queries.dozoAdmin.users.key()],
    onSaved: (_saved, input) => {
      setConfirm(null);
      if (input.kind === "delete") navigate("/admin", { replace: true });
    },
    onFailed: (error) => toast.error(errorText(error, t`Could not change the account`)),
  });
  /** The subscription's state in words; one this page does not know reads as inactive. */
  const subscriptionStatus = (status: string) => {
    switch (status) {
      case "trialing":
        return t`Subscription on trial`;
      case "active":
        return t`Subscription active`;
      case "past_due":
        return t`Subscription payment due`;
      case "canceled":
        return t`Subscription cancelled`;
      default:
        return t`Subscription inactive`;
    }
  };
  const date = (value: string) =>
    new Date(value).toLocaleDateString(i18n.locale, { dateStyle: "medium" });

  const back = (
    <Link
      to="/admin"
      className={buttonVariants({ variant: "ghost", size: "sm" })}
      aria-label={t`Members`}
    >
      <ChevronLeft />
      <Trans>Members</Trans>
    </Link>
  );
  if (account.isPending) return back;
  if (account.isError)
    return (
      <>
        {back}
        <div role="alert" className="flex items-center gap-3 text-body text-destructive">
          {errorText(account.error, t`Couldn't load the account`)}
          <Button variant="outline" size="sm" onClick={() => void account.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      </>
    );

  const user = account.data;
  const own = user.id === ownId;
  const { billing, storage } = user;
  const joined = date(user.createdAt);
  const dates = [
    billing?.status ? subscriptionStatus(billing.status) : null,
    billing?.trialEndsAt ? t`Trial ends ${date(billing.trialEndsAt)}` : null,
    billing?.currentPeriodEndsAt
      ? billing.cancelAtPeriodEnd
        ? t`Ends ${date(billing.currentPeriodEndsAt)}`
        : t`Renews ${date(billing.currentPeriodEndsAt)}`
      : null,
    user.freeUntil ? t`Free period until ${date(user.freeUntil)}` : null,
    user.plan.grantedUntil ? t`Granted until ${date(user.plan.grantedUntil)}` : null,
  ].filter((value): value is string => value !== null);

  return (
    <>
      {back}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 truncate text-heading font-medium">{user.name}</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setName(user.name);
              setConfirm("rename");
            }}
          >
            <Trans>Rename</Trans>
          </Button>
          {user.banned ? (
            <Badge variant="outline">
              <Trans>Banned</Trans>
            </Badge>
          ) : user.suspended ? (
            <Badge variant="outline">
              <Trans>Suspended</Trans>
            </Badge>
          ) : null}
        </div>
        <p
          data-testid="admin-account-identity"
          className="flex flex-wrap gap-x-3 text-body-sm text-muted-foreground"
        >
          <span>{user.email}</span>
          <span>{user.emailVerified ? t`Email verified` : t`Email not verified`}</span>
          <span>{t`Joined ${joined}`}</span>
        </p>
        {own ? null : (
          <div className="flex flex-wrap gap-1">
            {user.suspended ? (
              <Button
                variant="outline"
                size="sm"
                disabled={change.pending}
                onClick={() => change.run({ kind: "suspend", suspended: false })}
              >
                <Trans>Restore</Trans>
              </Button>
            ) : user.admin ? null : (
              <Button
                variant="outline"
                size="sm"
                disabled={change.pending}
                onClick={() => setConfirm("suspend")}
              >
                <Trans>Suspend</Trans>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={change.pending}
              onClick={() => setConfirm("sessions")}
            >
              <Trans>Sign out everywhere</Trans>
            </Button>
            {user.admin ? null : (
              <Button
                variant="outline"
                size="sm"
                disabled={change.pending}
                onClick={() => setConfirm("delete")}
              >
                <Trans>Delete</Trans>
              </Button>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeading>
          <Trans>Plan</Trans>
        </SectionHeading>
        <div className="flex flex-wrap items-center gap-3">
          <DozoPlanAction user={user} />
        </div>
        {dates.length > 0 ? (
          <p
            data-testid="admin-account-dates"
            className="flex flex-wrap gap-x-3 text-body-sm text-muted-foreground"
          >
            {dates.map((value) => (
              <span key={value}>{value}</span>
            ))}
          </p>
        ) : null}
        {storage ? (
          <p data-testid="admin-account-storage" className="text-body-sm text-muted-foreground">
            <Trans>
              {formatFileSize(storage.usedBytes)} of {formatFileSize(storage.limitBytes)} used
            </Trans>
          </p>
        ) : null}
      </section>

      {user.spaces.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>
            <Trans>Spaces</Trans>
          </SectionHeading>
          <Rows testId="admin-account-spaces">
            {user.spaces.map((space) => (
              <Row
                key={space.id}
                label={space.name}
                title={space.name}
                details={space.owned ? <span>{t`Own`}</span> : <span>{t`Invited`}</span>}
              />
            ))}
          </Rows>
        </section>
      ) : null}

      {user.bots.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>
            <Trans>Bots</Trans>
          </SectionHeading>
          <Rows testId="admin-account-bots">
            {user.bots.map((bot) => (
              <Row key={bot.id} label={bot.name} title={bot.name} details={null} />
            ))}
          </Rows>
        </section>
      ) : null}

      {user.computers.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>
            <Trans>Computers</Trans>
          </SectionHeading>
          <Rows testId="admin-account-computers">
            {user.computers.map((computer) => {
              const title = computer.bots.join(", ") || computer.id;
              return (
                <Row
                  key={computer.id}
                  label={title}
                  title={title}
                  details={
                    <>
                      <span>
                        {computer.running
                          ? computer.runningSince
                            ? t`Running since ${date(computer.runningSince)}`
                            : t`Running`
                          : t`Stopped`}
                      </span>
                      {computer.ownMachine ? <span>{t`On their own machine`}</span> : null}
                    </>
                  }
                />
              );
            })}
          </Rows>
        </section>
      ) : null}

      {user.sessions.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>
            <Trans>Sessions</Trans>
          </SectionHeading>
          <Rows testId="admin-account-sessions">
            {user.sessions.map((session) => {
              const title = session.userAgent ?? t`Unknown device`;
              return (
                <Row
                  key={session.id}
                  label={title}
                  title={title}
                  details={
                    <>
                      <span>{t`Last used ${date(session.lastUsedAt)}`}</span>
                      <span>{t`Signed in ${date(session.createdAt)}`}</span>
                    </>
                  }
                />
              );
            })}
          </Rows>
        </section>
      ) : null}

      {confirm === "rename" ? (
        <ConfirmDialog
          variant="default"
          title={<Trans>Rename {user.email}</Trans>}
          confirmLabel={<Trans>Save</Trans>}
          busy={change.pending}
          confirmDisabled={!name.trim()}
          onCancel={() => setConfirm(null)}
          onConfirm={() => change.run({ kind: "rename", name: name.trim() })}
        >
          <Input
            aria-label={t`Name`}
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
          />
        </ConfirmDialog>
      ) : confirm ? (
        <ConfirmDialog
          title={
            confirm === "sessions" ? (
              <Trans>Sign {user.email} out everywhere?</Trans>
            ) : confirm === "delete" ? (
              <Trans>Delete {user.email}?</Trans>
            ) : (
              <Trans>Suspend {user.email}?</Trans>
            )
          }
          description={
            confirm === "sessions" ? (
              <Trans>
                Ends every sign-in and disconnects their computers. They can sign in again.
              </Trans>
            ) : confirm === "delete" ? (
              <Trans>This cannot be undone.</Trans>
            ) : (
              <Trans>Signs them out, stops their bots and removes them from shared Spaces.</Trans>
            )
          }
          confirmLabel={
            confirm === "sessions" ? (
              <Trans>Sign out</Trans>
            ) : confirm === "delete" ? (
              <Trans>Delete</Trans>
            ) : (
              <Trans>Suspend</Trans>
            )
          }
          busy={change.pending}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            change.run(
              confirm === "suspend" ? { kind: "suspend", suspended: true } : { kind: confirm },
            )
          }
        />
      ) : null}
    </>
  );
}
