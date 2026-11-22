/**
 * The one key two skill names are compared by: trimmed of every whitespace `String.trim` trims
 * (spaces, tabs, line ends, no-break spaces and the rest) and lower-cased. The name resolver
 * (`findSkillByName`), the organization library's precedence and its refusal of a built-in name
 * all compare with it, so a name that resolves to a skill is the same name everywhere.
 */
export function skillNameKey(name: string): string {
  return name.trim().toLowerCase();
}
