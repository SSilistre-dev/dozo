import { useLingui } from "@lingui/react/macro";
import type { SettingsNavItem } from "./settings-nav";
import type { SettingsSection } from "./shell-overlay";

/**
 * The settings sections under three quiet headings (dozo/design/settings-v2.html): the account's
 * own pages, what the bots use, and the app itself. Which sections exist is still upstream's
 * decision (plan, role, desktop); a heading with none of its sections is left out, and a section
 * this list does not know yet goes under App, so nothing upstream adds is lost.
 */
const DOZO_SETTINGS_NAV_GROUPS = {
  account: ["general", "usage", "billing", "organization"],
  bots: ["models", "confirmations", "vault", "wallet", "memory", "voice", "messaging", "computer"],
  app: ["labs", "updates"],
} as const satisfies Record<string, readonly SettingsSection[]>;

export type DozoSettingsNavGroupId = keyof typeof DOZO_SETTINGS_NAV_GROUPS;

/** The available items in their group and group order; empty groups are dropped. */
export function dozoSettingsNavGroups(
  items: SettingsNavItem[],
): { id: DozoSettingsNavGroupId; items: SettingsNavItem[] }[] {
  const listed = new Set<string>(Object.values(DOZO_SETTINGS_NAV_GROUPS).flat());
  return (Object.keys(DOZO_SETTINGS_NAV_GROUPS) as DozoSettingsNavGroupId[])
    .map((id) => {
      const order: readonly string[] = DOZO_SETTINGS_NAV_GROUPS[id];
      const own = order
        .map((section) => items.find((item) => item.id === section))
        .filter((item): item is SettingsNavItem => Boolean(item));
      const unknown = id === "app" ? items.filter((item) => !listed.has(item.id)) : [];
      return { id, items: [...own, ...unknown] };
    })
    .filter((group) => group.items.length > 0);
}

/** The settings nav's buttons, upstream's markup and behaviour, grouped under their headings. */
export function DozoSettingsNavGroups({
  items,
  section,
  disabled,
  onSectionChange,
}: {
  items: SettingsNavItem[];
  section: SettingsSection;
  disabled: boolean;
  onSectionChange: (section: SettingsSection) => void;
}) {
  const { t } = useLingui();
  const labels: Record<DozoSettingsNavGroupId, string> = {
    account: t`Account`,
    bots: t`Bots`,
    app: t`App`,
  };
  return dozoSettingsNavGroups(items).map((group) => (
    <div
      key={group.id}
      role="group"
      aria-labelledby={`dozo-settings-nav-${group.id}`}
      data-dozo-settings-group={group.id}
      className="contents md:flex md:flex-col md:gap-0.5"
    >
      <div
        id={`dozo-settings-nav-${group.id}`}
        className="hidden md:block"
        data-dozo-settings-label
      >
        {labels[group.id]}
      </div>
      {group.items.map((item) => {
        const Icon = item.icon;
        // A space's page is reached from General, so General stays marked.
        const active = item.id === (section === "space" ? "general" : section);
        return (
          <button
            key={item.id}
            type="button"
            data-testid={`settings-nav-${item.id}`}
            aria-current={active ? "page" : undefined}
            disabled={disabled}
            onClick={() => onSectionChange(item.id)}
            className={`flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-body transition-colors disabled:pointer-events-none disabled:opacity-50 ${
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <Icon className="size-4 shrink-0" strokeWidth={1.75} />
            <span className="whitespace-nowrap">{item.label}</span>
          </button>
        );
      })}
    </div>
  ));
}
