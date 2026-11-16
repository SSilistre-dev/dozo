import type { Surface } from "../fixtures";
import { bots } from "./bots";
import { computer } from "./computer";
import { onboarding } from "./onboarding";
import { overlays } from "./overlays";
import { routes } from "./routes";
import { hiddenSections } from "./settings";
import { shell } from "./shell";
import { spaces } from "./spaces";

export const appSurfaces: Surface[] = [
  ...shell,
  ...bots,
  ...spaces,
  ...overlays,
  ...routes,
  ...onboarding,
  ...computer,
  hiddenSections,
];
