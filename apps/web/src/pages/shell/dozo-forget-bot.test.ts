import type { Bot } from "@rakazo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { dozoForgetBot } from "./dozo-forget-bot";

const key = (procedure: string, input: object) => [
  ["user:u", "space:s", ...procedure.split(".")],
  { input, type: "query" },
];

it("drops the deleted bot from the roster and forgets every read of it, nothing else", () => {
  const client = new QueryClient();
  client.setQueryData(key("routines.list", { botId: "gone" }), []);
  client.setQueryData(key("skills.list", { botId: "gone" }), []);
  client.setQueryData(key("routines.list", { botId: "kept" }), []);
  client.setQueryData(key("bots.list", {}), []);
  let roster = [{ id: "gone" }, { id: "kept" }] as Bot[];
  dozoForgetBot(
    client,
    (next) => {
      roster = typeof next === "function" ? next(roster) : next;
    },
    "gone",
  );
  expect(roster.map((bot) => bot.id)).toEqual(["kept"]);
  expect(
    client
      .getQueryCache()
      .getAll()
      .map((query) => (query.queryKey[0] as string[]).slice(2).join(".")),
  ).toEqual(["routines.list", "bots.list"]);
  expect(client.getQueryData(key("routines.list", { botId: "kept" }))).toEqual([]);
});
