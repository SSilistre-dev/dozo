import { useLingui } from "@lingui/react/macro";
import type { DozoThemePalette } from "@rakazo/ui-tokens/dozo-themes";
import { DOZO_DEFAULT_SWATCHES, DOZO_THEMES, dozoTheme } from "@rakazo/ui-tokens/dozo-themes";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import type { DozoBubble } from "../lib/dozo-ui-theme";
import {
  dozoBubblePreference,
  dozoThemePreference,
  setDozoBubble,
  setDozoTheme,
  setUiAppearance,
} from "../lib/dozo-ui-theme";
import type { AppearancePreference } from "../lib/ui-appearance";

// Settings > General > Appearance and Message color (dozo/design/settings-v2.html). Both load
// with the settings window, never before the app's first paint.

type Swatch = Pick<DozoThemePalette, "background" | "foreground">;
type Choice = { value: string; label: string; swatch: Swatch | "system" };

function ThemeSwatch({ swatch }: { swatch: Choice["swatch"] }) {
  // The theme's own colours: a preview of what picking it paints, so they cannot be tokens.
  const background =
    swatch === "system"
      ? `linear-gradient(135deg, ${DOZO_DEFAULT_SWATCHES.dark.background} 50%, ${DOZO_DEFAULT_SWATCHES.light.background} 50%)`
      : `linear-gradient(135deg, ${swatch.background} 50%, ${swatch.foreground} 50%)`;
  return (
    <span
      aria-hidden
      className="size-4 shrink-0 rounded-full ring-1 ring-foreground/15 ring-inset"
      style={{ background }}
    />
  );
}

function ChoiceLabel({ choice }: { choice: Choice }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ThemeSwatch swatch={choice.swatch} />
      <span className="truncate">{choice.label}</span>
    </span>
  );
}

/**
 * System, Light, Dark, then the named themes. A named theme shows as chosen only while upstream's
 * stored choice is still its tone; any other stored name reads as the plain choice.
 */
export function DozoAppearancePicker({
  value,
  onChange,
}: {
  value: AppearancePreference;
  onChange: (next: AppearancePreference) => void;
}) {
  const { t } = useLingui();
  const stored = dozoTheme(dozoThemePreference.use());
  const current = stored && stored.tone === value ? stored.id : value;
  const basics: Choice[] = [
    { value: "system", label: t`System`, swatch: "system" },
    { value: "light", label: t`Light`, swatch: DOZO_DEFAULT_SWATCHES.light },
    { value: "dark", label: t`Dark`, swatch: DOZO_DEFAULT_SWATCHES.dark },
  ];
  const named: Choice[] = DOZO_THEMES.map((theme) => ({
    value: theme.id,
    label: theme.label,
    swatch: theme.palette,
  }));
  const choices = [...basics, ...named];
  const item = (choice: Choice) => (
    <SelectItem
      key={choice.value}
      value={choice.value}
      label={choice.label}
      data-testid={`ui-appearance-${choice.value}`}
    >
      <ChoiceLabel choice={choice} />
    </SelectItem>
  );

  return (
    <Select
      value={current}
      items={choices}
      onValueChange={(next) => {
        const theme = dozoTheme(next);
        if (theme) {
          setDozoTheme(theme);
          onChange(theme.tone);
          return;
        }
        const basic = basics.find((choice) => choice.value === next);
        if (!basic) return;
        setUiAppearance(basic.value as AppearancePreference);
        onChange(basic.value as AppearancePreference);
      }}
    >
      <SelectTrigger
        aria-label={t`Appearance`}
        data-testid="ui-appearance-select"
        className="w-40 max-w-full"
      >
        <SelectValue>
          {(selected: string) => (
            // Always one of the choices: the value is `current`, which is one by construction.
            <ChoiceLabel choice={choices.find((entry) => entry.value === selected) as Choice} />
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>{basics.map(item)}</SelectGroup>
        <SelectSeparator />
        <SelectGroup>{named.map(item)}</SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function DozoMessageColorPicker() {
  const { t } = useLingui();
  const bubble = dozoBubblePreference.use();
  const options: { value: DozoBubble; label: string }[] = [
    { value: "bot", label: t`Bot color` },
    { value: "neutral", label: t`Neutral` },
  ];
  return (
    <ToggleGroup
      aria-label={t`Message color`}
      data-testid="dozo-message-color"
      value={[bubble]}
      onValueChange={([next]) => {
        if (next) setDozoBubble(next as DozoBubble);
      }}
      spacing={1}
      className="grid min-w-0 grid-cols-2 rounded-lg bg-muted p-1"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          data-testid={`dozo-message-color-${option.value}`}
          className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
