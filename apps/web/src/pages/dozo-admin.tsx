import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Badge,
  Button,
  buttonVariants,
  ListSearchInput,
  SectionHeading,
  Spinner,
  toast,
} from "@rakazo/ui-web";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useDeferredValue, useState } from "react";
import { Link } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PageLoading } from "../components/PageLoading";
import { useSave, useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";
import { NotFoundPage } from "./NotFound";
import { WindowChrome } from "./WindowChrome";

/** The hosted deployment's admin page. Anyone else sees the page an unknown address shows. */
export function DozoAdminPage() {
  const { t } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  if (me.isPending) return <PageLoading />;
  if (!me.data?.isAdmin) return <NotFoundPage />;
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-1 border-b px-4 py-3">
        <Link
          to="/app"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="flex-1 px-2 font-medium">
          <Trans>Admin</Trans>
        </h1>
        <Link to="/admin/access" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <Trans>Free access</Trans>
        </Link>
        <Link to="/admin/plugins" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <Trans>Plugins</Trans>
        </Link>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-6">
          <AdminPanel ownId={me.data.userId} />
        </div>
      </main>
    </div>
  );
}

type Action =
  | { suspend: string; email: string; suspended: boolean }
  | { stop: string; email: string | null };

function AdminPanel({ ownId }: { ownId: string }) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());
  // Read once, and again whenever the window comes back: nothing here is polled.
  const users = useInfiniteQuery(
    queries.dozoAdmin.users.infiniteOptions({
      input: (cursor: string | null) => ({
        ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
      placeholderData: (previous) => previous,
      refetchOnWindowFocus: "always",
    }),
  );
  const computers = useQuery({
    ...queries.dozoAdmin.computers.queryOptions(),
    refetchOnWindowFocus: "always",
  });
  const [confirm, setConfirm] = useState<Action | null>(null);
  const change = useSave({
    save: async (input: Action, rpc) => {
      if ("stop" in input) await rpc.dozoAdmin.stopComputer({ computerId: input.stop });
      else await rpc.dozoAdmin.setSuspended({ userId: input.suspend, suspended: input.suspended });
    },
    stale: [queries.dozoAdmin.users.key(), queries.dozoAdmin.computers.key()],
    onFailed: (error, input) =>
      toast.error(
        errorText(
          error,
          "stop" in input ? t`Could not stop the computer` : t`Could not change the account`,
        ),
      ),
  });
  const date = (value: string) =>
    new Date(value).toLocaleDateString(i18n.locale, { dateStyle: "medium" });
  const joined = (value: string) => {
    const day = date(value);
    return t`Joined ${day}`;
  };
  const lastSeen = (value: string) => {
    const day = date(value);
    return t`Last seen ${day}`;
  };
  const since = (value: string) => {
    const time = new Date(value).toLocaleString(i18n.locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    return t`Since ${time}`;
  };

  if (users.isPending || computers.isPending)
    return (
      <div className="grid place-items-center py-10">
        <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
      </div>
    );
  if (users.isError || computers.isError)
    return (
      <div role="alert" className="flex items-center gap-3 text-body text-destructive">
        {errorText(users.error ?? computers.error, t`Couldn't load the admin page`)}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void users.refetch();
            void computers.refetch();
          }}
        >
          <Trans>Retry</Trans>
        </Button>
      </div>
    );

  const first = users.data.pages[0];
  const list = users.data.pages.flatMap((page) => page.users);
  return (
    <>
      <p data-testid="admin-status" className="flex flex-wrap gap-x-4 text-body-sm">
        <span>
          {first?.signupsOpen ? <Trans>Sign-up open</Trans> : <Trans>Sign-up closed</Trans>}
        </span>
        <span className="text-muted-foreground">
          <Plural value={first?.total ?? 0} one="# user" other="# users" />
        </span>
        <span className="text-muted-foreground">
          <Plural
            value={computers.data.total}
            one="# computer running"
            other="# computers running"
          />
        </span>
      </p>

      {computers.data.computers.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading>
            <Trans>Computers</Trans>
          </SectionHeading>
          <Rows testId="admin-computers">
            {computers.data.computers.map((computer) => (
              <Row
                key={computer.id}
                label={computer.email ?? computer.id}
                title={computer.email ?? "—"}
                details={
                  <>
                    <span className="truncate">{computer.bots.join(", ")}</span>
                    {computer.runningSince ? <span>{since(computer.runningSince)}</span> : null}
                  </>
                }
              >
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={change.pending}
                  onClick={() => setConfirm({ stop: computer.id, email: computer.email })}
                >
                  <Trans>Stop</Trans>
                </Button>
              </Row>
            ))}
          </Rows>
        </section>
      ) : null}

      <section className="space-y-3">
        <SectionHeading>
          <Trans>Users</Trans>
        </SectionHeading>
        <ListSearchInput
          query={search}
          setQuery={setSearch}
          label={t`Search by email`}
          placeholder={t`Search by email`}
        />
        <Rows testId="admin-users">
          {list.map((user) => (
            <Row
              key={user.id}
              label={user.email}
              title={user.email}
              details={
                <>
                  <span className="truncate">{user.name}</span>
                  <span>{joined(user.createdAt)}</span>
                  {user.lastSeenAt ? <span>{lastSeen(user.lastSeenAt)}</span> : null}
                  <span>
                    <Plural value={user.bots} one="# bot" other="# bots" />
                  </span>
                  {user.runningComputers > 0 ? (
                    <span>
                      <Plural value={user.runningComputers} one="# computer" other="# computers" />
                    </span>
                  ) : null}
                </>
              }
            >
              {user.suspended ? (
                <Badge variant="outline">
                  <Trans>Suspended</Trans>
                </Badge>
              ) : null}
              {user.id === ownId ? null : user.suspended ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={change.pending}
                  onClick={() =>
                    change.run({ suspend: user.id, email: user.email, suspended: false })
                  }
                >
                  <Trans>Restore</Trans>
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={change.pending}
                  onClick={() =>
                    setConfirm({ suspend: user.id, email: user.email, suspended: true })
                  }
                >
                  <Trans>Suspend</Trans>
                </Button>
              )}
            </Row>
          ))}
        </Rows>
        {users.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            disabled={users.isFetchingNextPage}
            onClick={() => void users.fetchNextPage()}
          >
            <Trans>Load more</Trans>
          </Button>
        ) : null}
      </section>

      {confirm ? (
        <ConfirmDialog
          title={
            "stop" in confirm ? (
              <Trans>Stop this computer?</Trans>
            ) : (
              <Trans>Suspend {confirm.email}?</Trans>
            )
          }
          description={
            "stop" in confirm ? (
              confirm.email
            ) : (
              <Trans>Signs them out, stops their bots and removes them from shared Spaces.</Trans>
            )
          }
          confirmLabel={"stop" in confirm ? <Trans>Stop</Trans> : <Trans>Suspend</Trans>}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            change.run(confirm);
          }}
        />
      ) : null}
    </>
  );
}

function Rows({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <ul data-testid={testId} className="divide-y divide-border rounded-xl border border-border">
      {children}
    </ul>
  );
}

function Row({
  label,
  title,
  details,
  children,
}: {
  label: string;
  title: string;
  /** One `span` per field. */
  details: ReactNode;
  children: ReactNode;
}) {
  return (
    <li aria-label={label} className="flex items-center gap-3 px-4 py-3 text-body-sm">
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-medium">{title}</div>
        <div className="flex min-w-0 flex-wrap gap-x-3 text-muted-foreground">{details}</div>
      </div>
      {children}
    </li>
  );
}
