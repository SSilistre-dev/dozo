import type { ConnectionCatalogItem } from "@rakazo/contracts";
import { findBotTemplate } from "@rakazo/core";
import { expect, it } from "vitest";
import { templateAppCards, templatePlan } from "./bots/bot-templates.js";

// Runs on the branded tree, where "meeting-prep" is in the template list.

const prep = () => findBotTemplate("meeting-prep")!;
const calendar = (connected: boolean) =>
  ({
    connectorId: "first",
    slug: "googlecalendar",
    name: "Google Calendar",
    logo: null,
    connected,
    noAuth: false,
  }) as ConnectionCatalogItem;

it("creates the planning routine paused, with the skill it mentions", () => {
  const { plan, routineInputs } = templatePlan(prep(), "Europe/Istanbul");
  expect(plan.skills.map((skill) => skill.name)).toEqual(["Meeting prep"]);
  expect(plan.skills[0]!.content).toContain("schedule_create");
  expect([...routineInputs.values()]).toEqual([
    expect.objectContaining({
      name: "Plan meeting prep",
      prompt: "Plan today's meeting prep with @Meeting prep.",
      crons: ["0 7 * * 1-5"],
      timezone: "Europe/Istanbul",
      active: false,
    }),
  ]);
  expect(plan.routines.map((routine) => routine.status)).toEqual([
    { kind: "needs_setup", needs: [{ kind: "turn_on" }] },
  ]);
});

it("asks to connect the calendar when it is not connected, and not when it is", () => {
  expect(templateAppCards(prep(), [calendar(false)])).toEqual([
    expect.objectContaining({ kind: "app_connect", name: "Google Calendar", status: "pending" }),
  ]);
  expect(templateAppCards(prep(), [calendar(true)])).toEqual([]);
});
