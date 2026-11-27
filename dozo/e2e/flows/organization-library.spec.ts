import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { APPEARANCE_KEY, readWorld } from "../fixtures";
import { outDir } from "../scan";
import { connectModelThroughOnboarding } from "../support";
import { openAccountMenu, openBot } from "../ui";
import { newAccount, rpcAs } from "./accounts";
import { expect, test } from "./flow";

async function shot(page: Page, name: string) {
  mkdirSync(`${outDir()}/shots`, { recursive: true });
  await page.screenshot({
    path: `${outDir()}/shots/organization-library--${name}.png`,
    animations: "disabled",
  });
}

type Skill = { id: string; name: string; readOnly: boolean };

/** An RPC in a named Space, as the app sends it once that Space is open. */
async function rpcIn<T>(page: Page, spaceId: string, procedure: string, body?: unknown) {
  // No input is sent as an empty body, as the app's client does; a literal null is not "no input".
  const response = await page.request.post(`/rpc/${procedure}`, {
    data: body === undefined ? {} : { json: body },
    headers: { "x-rakazo-space-id": spaceId },
  });
  expect(response.ok(), `${procedure} answered ${response.status()}`).toBe(true);
  return ((await response.json()) as { json: T }).json;
}

/** Opens the Skills page from the account menu, then the named skill. */
async function openSkill(page: Page, name: string) {
  const menu = await openAccountMenu(page);
  await menu.getByRole("button", { name: "Skills", exact: true }).click();
  const list = page.getByTestId("bot-knowledge-skills");
  await expect(list).toBeVisible();
  await list.getByRole("button", { name: new RegExp(name) }).click();
  await expect(list.getByRole("textbox", { name: "SKILL.md" })).toBeVisible();
  return list;
}

const appearance = (page: Page, theme: "dark" | "light") =>
  page.addInitScript((value) => localStorage.setItem(value.key, value.theme), {
    key: APPEARANCE_KEY,
    theme,
  });

/**
 * The organization's owner puts a skill they wrote in its library with the switch in the skill's
 * editor; a member invited to one of its Spaces then finds it there, read only. Taking it out
 * again takes it away from them.
 */
test("organization library: the owner shares a skill, a member of its Space reads it read only", async ({
  page,
  browser,
  guard,
}) => {
  test.setTimeout(300_000);
  const world = readWorld();
  const name = `team-expenses-${Math.random().toString(36).slice(2, 7)}`;
  const nav = await rpcAs<{ current: { id: string } }>(page, "spaces/list");
  const spaceId = nav.current.id;
  const skill = await rpcAs<Skill>(page, "agentSkills/create", {
    name,
    description: "File expenses the team way",
    body: "Attach every receipt.",
  });
  const invite = await rpcAs<{ url: string }>(page, "spaces/invites/create", { spaceId });
  const member = await newAccount(browser, "library-member");
  await connectModelThroughOnboarding(member.page);
  await rpcAs(member.page, "spaces/invites/accept", { token: invite.url.split("/").pop() });
  const memberSkills = () => rpcIn<Skill[]>(member.page, spaceId, "agentSkills/list");
  expect((await memberSkills()).some((entry) => entry.name === name)).toBe(false);

  await appearance(page, "dark");
  await openBot(page, world.chiefId, "Chief");
  const editor = await openSkill(page, name);
  const toggle = editor.getByTestId("organization-library-switch");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await shot(page, "1-owner-dark");
  await appearance(page, "light");
  await openBot(page, world.chiefId, "Chief");
  await openSkill(page, name);
  await shot(page, "2-owner-light");

  expect((await memberSkills()).find((entry) => entry.name === name)).toMatchObject({
    id: skill.id,
    readOnly: true,
  });
  guard.follow(member.page);
  for (const theme of ["dark", "light"] as const) {
    await member.page.addInitScript(
      (value) => {
        localStorage.setItem(value.key, value.theme);
        localStorage.setItem("rakazo:space-id", value.spaceId);
      },
      { key: APPEARANCE_KEY, theme, spaceId },
    );
    await member.page.goto("/app");
    const opened = await openSkill(member.page, name);
    await expect(opened.getByRole("textbox", { name: "SKILL.md" })).toHaveAttribute("readonly", "");
    await expect(opened.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(opened.getByRole("button", { name: "Delete" })).toHaveCount(0);
    // The switch says where the skill comes from; on, the member's bots use it.
    await expect(opened.getByTestId("organization-library-switch")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await shot(member.page, `3-member-${theme}`);
  }
  expect((await memberSkills()).some((entry) => entry.name === name)).toBe(true);

  // Turned off by the member: their skills leave it out, the library lists it as off for them.
  await rpcIn(member.page, spaceId, "dozoOrganizationLibrary/hide", {
    skillId: skill.id,
    hidden: true,
  });
  expect((await memberSkills()).some((entry) => entry.name === name)).toBe(false);
  await rpcIn(member.page, spaceId, "dozoOrganizationLibrary/hide", {
    skillId: skill.id,
    hidden: false,
  });
  expect((await memberSkills()).some((entry) => entry.name === name)).toBe(true);

  await rpcIn(page, spaceId, "dozoOrganizationLibrary/share", { skillId: skill.id, shared: false });
  expect((await memberSkills()).some((entry) => entry.name === name)).toBe(false);
});
