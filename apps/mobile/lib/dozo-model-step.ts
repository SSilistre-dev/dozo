import { router } from "expo-router";

/**
 * The first bot's model step: instead of an alert that asks first, open the model screen in place
 * of the New bot screen, so the step is one move. Anchored rules in lib/inbox/create-inbox-bot.ts
 * and app/new-bot.tsx use it; the same name as upstream's alert, which the send queue keeps.
 */
export function askToAddModel(spaceId?: string) {
  router.replace(
    spaceId ? { pathname: "/(settings)/models", params: { spaceId } } : "/(settings)/models",
  );
}
