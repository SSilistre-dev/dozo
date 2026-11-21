/**
 * Whether saving a model connection makes it the main model. Asking for it does (unless the caller
 * keeps one that exists); saying nothing does only while there is no main model or this connection
 * already runs it (named, or as its provider's connection), so saving another connection's form
 * never moves the main model off the one the person picked.
 */
export function dozoBecomesMain(
  input: { makeDefault?: boolean; keepExistingDefault?: boolean },
  main: { provider: string; credentialId?: string | null } | null | undefined,
  credential: { id: string; provider: string },
): boolean {
  if (input.makeDefault === false) return false;
  if (input.keepExistingDefault) return !main;
  if (input.makeDefault !== undefined) return true;
  if (!main) return true;
  return main.credentialId
    ? main.credentialId === credential.id
    : main.provider === credential.provider;
}
