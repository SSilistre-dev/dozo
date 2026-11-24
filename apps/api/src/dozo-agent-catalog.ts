import { isAgentProvider, localCliHost } from "@rakazo/adapters";

/**
 * The models a person is offered on a hosted server: an agent's are listed only once they have a
 * connection to it (one on a computer of theirs), so the catalog never offers an agent that asks
 * for a key to connect, where no key exists. A choice already saved (`selected`, as `provider:id`)
 * stays listed, so a role whose connection was removed still shows its model. On the person's own
 * computer nothing changes. Which providers are agents is the adapters' own list.
 */
export function withoutUnconnectedAgents<T extends { provider: string; id: string }>(
  entries: T[],
  connected: { byProvider: Record<string, unknown>; byModel: Record<string, unknown> },
  selected?: ReadonlySet<string>,
): T[] {
  if (localCliHost()) return entries;
  return entries.filter(
    (entry) =>
      !isAgentProvider(entry.provider) ||
      Boolean(connected.byProvider[entry.provider] || connected.byModel[entry.provider]) ||
      selected?.has(`${entry.provider}:${entry.id}`) === true,
  );
}
