import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoBotSharePublic } from "@rakazo/contracts";
import { DOZO_SHARE_LINK_WEB_PREFIX, DozoBotSharePublicSchema } from "@rakazo/contracts";
import { errorCode } from "@rakazo/core";
import { Button, Field, FieldGroup, FieldLabel, OptionSelect, Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SectionLoadFailed } from "../components/ErrorBoundary";
import { toastError } from "../lib/dozo-error-text";
import { useQueryUserId, useSave, useSpaceQueries } from "../lib/query/query";
import { selectedSpaceId, selectSpace } from "../lib/query/rpc";
import { DozoBotDefinition, dozoBotShown } from "./dozo-bot-definition";

/**
 * A shared bot's page. Signed out it shows what the link shows: the avatar, name, first lines of
 * the instructions and the routine names. Signed in it shows the whole definition, and making a
 * copy creates the person's own bot from it in the Space they pick.
 */
export function DozoBotSharePage({ payload }: { payload: unknown }) {
  const parsed = DozoBotSharePublicSchema.safeParse(payload);
  const userId = useQueryUserId();
  if (!parsed.success) return <SectionLoadFailed />;
  return (
    <main className="mx-auto flex min-h-full w-full max-w-xl flex-col gap-6 p-6 text-foreground">
      {userId ? <Copyable token={tokenOfPage()} /> : <SignedOut shared={parsed.data} />}
    </main>
  );
}

function tokenOfPage(): string {
  return window.location.pathname.slice(DOZO_SHARE_LINK_WEB_PREFIX.length);
}

function SignedOut({ shared }: { shared: DozoBotSharePublic }) {
  const next = encodeURIComponent(window.location.pathname);
  return (
    <>
      <DozoBotDefinition
        bot={{
          name: shared.name,
          color: shared.avatar.color,
          instructions: shared.instructionsExcerpt,
          routines: shared.routineNames.map((name) => ({ name })),
        }}
      />
      <Button render={<Link to={`/sign-in?next=${next}`} />} nativeButton={false}>
        <Trans>Sign in to make a copy</Trans>
      </Button>
    </>
  );
}

function Copyable({ token }: { token: string }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const queries = useSpaceQueries();
  const opened = useQuery({
    ...queries.dozoBotShares.open.queryOptions({ input: { token } }),
    retry: false,
  });
  const spaces = useQuery(queries.spaces.list.queryOptions()).data?.spaces ?? [];
  const [spaceId, setSpaceId] = useState(selectedSpaceId());
  // One id per page: a second click, or a retry after a lost answer, returns the same bot.
  const [requestId] = useState(() => crypto.randomUUID());
  const copy = useSave({
    save: (fingerprint: string, rpc) => rpc.dozoBotShares.clone({ token, fingerprint, requestId }),
    onSaved: ({ bot }) => navigate(`/app/${bot.id}`),
    onFailed: (error) => {
      if (errorCode(error) === "BOT_SHARE_CHANGED") void opened.refetch();
      toastError(t`Could not make a copy`, error);
    },
    closesScreen: true,
  });
  const shown = opened.data;
  if (opened.isError) return <SectionLoadFailed />;
  if (!shown) return <Spinner />;
  return (
    <>
      <DozoBotDefinition bot={dozoBotShown(shown.definition)} />
      {spaces.length > 1 ? (
        <FieldGroup>
          <Field>
            <FieldLabel id="bot-share-space">
              <Trans>Space</Trans>
            </FieldLabel>
            <OptionSelect
              aria-labelledby="bot-share-space"
              value={spaceId}
              options={spaces.map((space) => ({ value: space.id, label: space.name }))}
              onValueChange={setSpaceId}
            />
          </Field>
        </FieldGroup>
      ) : null}
      <Button
        disabled={copy.pending}
        onClick={() => {
          // The copy goes to the Space picked, which the app then opens.
          if (spaceId && spaceId !== selectedSpaceId()) selectSpace(spaceId);
          copy.run(shown.fingerprint);
        }}
      >
        <Trans>Make a copy</Trans>
      </Button>
    </>
  );
}
