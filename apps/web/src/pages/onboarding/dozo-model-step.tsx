import { Trans, useLingui } from "@lingui/react/macro";
import { MODEL_KEY_REJECTED_ERROR } from "@rakazo/contracts";
import { DOZO_FEATURED_MODEL_OPTIONS } from "@rakazo/core";
import { translateRunError } from "@rakazo/i18n/run-error";
import { Button } from "@rakazo/ui-web";
import type { ComponentProps } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { DozoLocalModels } from "../dozo-local-models";
import { ModelStep as UpstreamModelStep } from "./model-step";
import type { OnboardingModel } from "./use-onboarding-model";

/** The last choice in the short list; picking it shows every other provider. */
const MORE_OPTION = "__dozo_more__";

type Option = OnboardingModel["providerOptions"]["main"][number];

/**
 * Whether the deployment sells model credits. Onboarding offers credits only then: picking them
 * while they are not on sale went back to the same step. Unknown counts as not on sale. A server
 * without billing (`billingEnabled` from `me`) has no billing routes, so it is not asked.
 */
export async function dozoCreditsOnSale(
  billingEnabled: boolean,
  signal: AbortSignal,
): Promise<boolean> {
  if (!billingEnabled) return false;
  return rpc.billing.status(undefined, { signal }).then(
    (status) => status.creditPurchasesEnabled !== false,
    () => false,
  );
}

/**
 * The featured ways to connect first (credits ahead of them when offered, as upstream places
 * them), then "More" while the rest are folded. The order comes from the featured list.
 */
export function dozoProviderChoices(
  options: OnboardingModel["providerOptions"],
  expanded: boolean,
  moreLabel: string,
): { main: Option[]; rest: Option[]; first: Option | undefined } {
  const all = [...options.main, ...options.rest];
  const featured = DOZO_FEATURED_MODEL_OPTIONS.flatMap((value) =>
    all.filter((option) => option.value === value),
  );
  // Upstream's own extras (credits) stay where upstream put them: first.
  const leading = options.main.filter(
    (option, index) => index === 0 && !DOZO_FEATURED_MODEL_OPTIONS.includes(option.value),
  );
  const shown = new Set([...featured, ...leading].map((option) => option.value));
  const rest = all.filter((option) => !shown.has(option.value));
  const more = !expanded && rest.length ? [{ value: MORE_OPTION, label: moreLabel }] : [];
  return {
    main: [...leading, ...featured, ...more],
    rest: expanded ? rest : [],
    first: featured[0],
  };
}

/**
 * Upstream's model step with a short provider list, a preselected provider, a plain message for a
 * rejected key, a way past the step, and the local-model panel under it.
 *
 * The local panel reloads: the page reads `me` once on mount with a direct `rpc.me` call, not a
 * query (Onboarding.tsx:41-51), so the reload re-derives the step from `needsModel`. "Later" is
 * handed `goTo("bot")` by an anchored rule, so it creates the first bot exactly as a connection
 * does; the app without a model refuses a send with a link to connect one.
 */
export function ModelStep({
  model,
  fieldId,
  onLater,
}: ComponentProps<typeof UpstreamModelStep> & { onLater?: () => void }) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const choices = useMemo(
    () => dozoProviderChoices(model.providerOptions, expanded, t`More`),
    [model.providerOptions, expanded, t],
  );

  const preselected = useRef(false);
  const { chooseProvider, credits, providerValue } = model;
  const first = choices.first?.value;
  useEffect(() => {
    if (preselected.current || !first) return;
    preselected.current = true;
    if (providerValue === null && !credits) chooseProvider(first);
  }, [first, providerValue, credits, chooseProvider]);

  const rejected = model.error === MODEL_KEY_REJECTED_ERROR;
  useEffect(() => {
    if (!rejected) return;
    const field = document.getElementById(`${fieldId}-api-key`);
    if (!(field instanceof HTMLInputElement)) return;
    field.focus();
    field.select();
  }, [rejected, fieldId]);

  const shown: OnboardingModel = {
    ...model,
    providerOptions: { main: choices.main, rest: choices.rest },
    // Labels resolve from every option, folded or not.
    providerItems: [...model.providerItems, ...choices.main],
    chooseProvider: (value: string) => {
      if (value === MORE_OPTION) setExpanded(true);
      else chooseProvider(value);
    },
    // The shared message for a rejected key, already translated.
    error: rejected
      ? translateRunError("{provider} rejected the API key. Check your connection settings.", {
          provider: model.selected?.providerName ?? model.provider,
        })
      : model.error,
  };

  return (
    <>
      <UpstreamModelStep model={shown} fieldId={fieldId} />
      {onLater ? (
        <Button variant="ghost" className="mt-2 -ml-3 text-muted-foreground" onClick={onLater}>
          <Trans>Later</Trans>
        </Button>
      ) : null}
      <div className="mt-6">
        <DozoLocalModels onConnected={() => window.location.assign("/onboarding")} />
      </div>
    </>
  );
}
