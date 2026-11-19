import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ByokTier, DozoAdminUsersSort } from "@rakazo/contracts";
import { BYOK_TIERS } from "@rakazo/contracts";
import {
  Badge,
  Button,
  buttonVariants,
  Input,
  ListSearchInput,
  NativeSelect,
  NativeSelectOption,
  SectionHeading,
  Spinner,
  toast,
} from "@rakazo/ui-web";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { Suspense, useDeferredValue, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PageLoading } from "../components/PageLoading";
import { useSave, useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";
import { DozoAdminAccount } from "./dozo-admin-account";
import { DOZO_ADMIN_NAV } from "./dozo-admin-nav";
import { DozoPlanAction } from "./dozo-admin-plan";
import { Row, Rows } from "./dozo-admin-rows";
import { NotFoundPage } from "./NotFound";
import { WindowChrome } from "./WindowChrome";

/**
 * The hosted deployment's admin page, at `/admin` and every address under it that has no route
 * of its own: its sections' navigation, and the section the address names. Anyone else sees the
 * page an unknown address shows.
 */
export function DozoAdminPage() {
  const { t, i18n } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  if (me.isPending) return <PageLoading />;
  if (!me.data?.isAdmin) return <NotFoundPage />;
  const ownId = me.data.userId;
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
        <h1 className="px-2 font-medium">
          <Trans>Admin</Trans>
        </h1>
        <nav aria-label={t`Admin`} className="flex min-w-0 flex-1 flex-wrap gap-1">
          {DOZO_ADMIN_NAV.map((section) => (
            <NavLink
              key={section.path}
              to={section.path ? `/admin/${section.path}` : "/admin"}
              end
              className={({ isActive }) =>
                buttonVariants({ variant: isActive ? "secondary" : "ghost", size: "sm" })
              }
            >
              {i18n._(section.label)}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-6">
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route index element={<AdminPanel ownId={ownId} />} />
              <Route path="users/:userId" element={<DozoAdminAccount ownId={ownId} />} />
              {DOZO_ADMIN_NAV.map(({ path, page: Page }) =>
                Page && path ? <Route key={path} path={path} element={<Page />} /> : null,
              )}
              <Route path="*" element={<Navigate to="/admin" replace />} />
            </Routes>
          </Suspense>
        </div>
      </main>
    </div>
  );
}

function Loading() {
  const { t } = useLingui();
  return (
    <div className="grid place-items-center py-10">
      <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
    </div>
  );
}

const SORTS: readonly DozoAdminUsersSort[] = ["newest", "oldest", "email"];
const PLANS: readonly ByokTier[] = ["standard", "pro", "max"];
type Status = "active" | "suspended";

type Action =
  | { suspend: string; email: string; suspended: boolean }
  | { ban: string; email: string }
  | { remove: string; email: string }
  | { banValue: string }
  | { unban: string }
  | { stop: string; email: string | null };

/** One decimal, none when it is a whole number. */
const gb = (value: number) => String(Math.round(value * 10) / 10);

function AdminPanel({ ownId }: { ownId: string }) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());
  const [sort, setSort] = useState<DozoAdminUsersSort>("newest");
  const [plan, setPlan] = useState<ByokTier | "">("");
  const [status, setStatus] = useState<Status | "">("");
  const filtered = Boolean(query || plan || status);
  // Read once, and again whenever the window comes back: nothing here is polled.
  const users = useInfiniteQuery(
    queries.dozoAdmin.users.infiniteOptions({
      input: (cursor: string | null) => ({
        ...(query ? { query } : {}),
        ...(cursor ? { cursor } : {}),
        ...(sort === "newest" ? {} : { sort }),
        ...(plan ? { plan } : {}),
        ...(status ? { status } : {}),
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
  const bans = useQuery({
    ...queries.dozoAdmin.bans.queryOptions(),
    refetchOnWindowFocus: "always",
  });
  const [banValue, setBanValue] = useState("");
  const [confirm, setConfirm] = useState<Action | null>(null);
  const change = useSave({
    save: async (input: Action, rpc) => {
      if ("stop" in input) await rpc.dozoAdmin.stopComputer({ computerId: input.stop });
      else if ("ban" in input) await rpc.dozoAdmin.ban({ userId: input.ban });
      else if ("remove" in input) await rpc.dozoAdmin.deleteUser({ userId: input.remove });
      else if ("unban" in input) await rpc.dozoAdmin.unban({ value: input.unban });
      else if ("banValue" in input) {
        await rpc.dozoAdmin.ban({ value: input.banValue });
        setBanValue("");
      } else
        await rpc.dozoAdmin.setSuspended({ userId: input.suspend, suspended: input.suspended });
    },
    stale: [
      queries.dozoAdmin.users.key(),
      queries.dozoAdmin.computers.key(),
      queries.dozoAdmin.bans.key(),
    ],
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

  if (users.isPending || computers.isPending || bans.isPending) return <Loading />;
  if (users.isError || computers.isError || bans.isError)
    return (
      <div role="alert" className="flex items-center gap-3 text-body text-destructive">
        {errorText(users.error ?? computers.error ?? bans.error, t`Couldn't load the admin page`)}
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void users.refetch();
            void computers.refetch();
            void bans.refetch();
          }}
        >
          <Trans>Retry</Trans>
        </Button>
      </div>
    );

  const first = users.data.pages[0];
  const list = users.data.pages.flatMap((page) => page.users);
  const usedGb = gb(computers.data.memory?.usedGb ?? 0);
  const totalGb = gb(computers.data.memory?.totalGb ?? 0);
  return (
    <>
      <p data-testid="admin-status" className="flex flex-wrap gap-x-4 text-body-sm">
        <span>
          {first?.signupsOpen ? <Trans>Sign-up open</Trans> : <Trans>Sign-up closed</Trans>}
        </span>
        <span className="text-muted-foreground">
          <Plural value={first?.total ?? 0} one="# user" other="# users" />
        </span>
        {filtered ? (
          <span data-testid="admin-matching" className="text-muted-foreground">
            <Plural value={first?.matching ?? 0} one="# match" other="# matches" />
          </span>
        ) : null}
        <span className="text-muted-foreground">
          <Plural
            value={computers.data.total}
            one="# computer running"
            other="# computers running"
          />
        </span>
        {computers.data.memory ? (
          <span className="text-muted-foreground">
            <Trans>
              {usedGb} of {totalGb} GB
            </Trans>
          </span>
        ) : null}
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
        <div className="flex flex-wrap gap-2">
          <NativeSelect
            aria-label={t`Plan`}
            value={plan}
            onChange={(event) => setPlan(event.target.value as ByokTier | "")}
          >
            <NativeSelectOption value="">{t`All plans`}</NativeSelectOption>
            {PLANS.map((tier) => (
              <NativeSelectOption key={tier} value={tier}>
                {BYOK_TIERS[tier].name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label={t`Status`}
            value={status}
            onChange={(event) => setStatus(event.target.value as Status | "")}
          >
            <NativeSelectOption value="">{t`Any status`}</NativeSelectOption>
            <NativeSelectOption value="active">{t`Active`}</NativeSelectOption>
            <NativeSelectOption value="suspended">{t`Suspended`}</NativeSelectOption>
          </NativeSelect>
          <NativeSelect
            aria-label={t`Sort`}
            value={sort}
            onChange={(event) => setSort(event.target.value as DozoAdminUsersSort)}
          >
            {SORTS.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {
                  {
                    newest: t`Newest first`,
                    oldest: t`Oldest first`,
                    email: t`By email`,
                  }[value]
                }
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Rows testId="admin-users">
          {list.map((user) => (
            <Row
              key={user.id}
              label={user.email}
              title={
                <Link to={`/admin/users/${user.id}`} className="hover:underline">
                  {user.email}
                </Link>
              }
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
              <DozoPlanAction user={user} />
              {user.banned ? (
                <Badge variant="outline">
                  <Trans>Banned</Trans>
                </Badge>
              ) : user.suspended ? (
                <Badge variant="outline">
                  <Trans>Suspended</Trans>
                </Badge>
              ) : null}
              {user.id === ownId ? null : (
                <>
                  {user.suspended ? (
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
                  {user.banned ? null : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={change.pending}
                      onClick={() => setConfirm({ ban: user.id, email: user.email })}
                    >
                      <Trans>Ban</Trans>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={change.pending}
                    onClick={() => setConfirm({ remove: user.id, email: user.email })}
                  >
                    <Trans>Delete</Trans>
                  </Button>
                </>
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

      <section className="space-y-3">
        <SectionHeading>
          <Trans>Banned</Trans>
        </SectionHeading>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (banValue.trim()) change.run({ banValue: banValue.trim() });
          }}
        >
          <Input
            value={banValue}
            onChange={(event) => setBanValue(event.target.value)}
            aria-label={t`Email or domain`}
            placeholder={t`Email or domain`}
            autoComplete="off"
            maxLength={254}
          />
          <Button type="submit" variant="outline" disabled={change.pending || !banValue.trim()}>
            <Trans>Ban</Trans>
          </Button>
        </form>
        {bans.data.bans.length > 0 ? (
          <Rows testId="admin-bans">
            {bans.data.bans.map((ban) => (
              <Row
                key={ban.value}
                label={ban.value}
                title={ban.value}
                details={<span>{date(ban.createdAt)}</span>}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={change.pending}
                  onClick={() => change.run({ unban: ban.value })}
                >
                  <Trans>Remove</Trans>
                </Button>
              </Row>
            ))}
          </Rows>
        ) : null}
      </section>

      {confirm && "email" in confirm ? (
        <ConfirmDialog
          title={
            "stop" in confirm ? (
              <Trans>Stop this computer?</Trans>
            ) : "ban" in confirm ? (
              <Trans>Ban {confirm.email}?</Trans>
            ) : "remove" in confirm ? (
              <Trans>Delete {confirm.email}?</Trans>
            ) : (
              <Trans>Suspend {confirm.email}?</Trans>
            )
          }
          description={
            "stop" in confirm ? (
              confirm.email
            ) : "ban" in confirm ? (
              <Trans>
                Suspends the account and refuses new sign-ups and sign-ins from its address.
              </Trans>
            ) : "remove" in confirm ? (
              <Trans>This cannot be undone.</Trans>
            ) : (
              <Trans>Signs them out, stops their bots and removes them from shared Spaces.</Trans>
            )
          }
          confirmLabel={
            "stop" in confirm ? (
              <Trans>Stop</Trans>
            ) : "ban" in confirm ? (
              <Trans>Ban</Trans>
            ) : "remove" in confirm ? (
              <Trans>Delete</Trans>
            ) : (
              <Trans>Suspend</Trans>
            )
          }
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
