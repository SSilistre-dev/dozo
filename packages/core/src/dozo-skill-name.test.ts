import { describe, expect, it } from "vitest";
import { findSkillByName, mergeBuiltinSkills } from "./agent-skill.js";
import { skillNameKey } from "./dozo-skill-name.js";

const SPACES = [" ", "\t", "\n", "\r\n", " ", " ", "﻿", "　"];

describe("the one key skill names are compared by", () => {
  it("drops every whitespace String.trim drops, and case", () => {
    for (const space of SPACES) {
      expect(skillNameKey(`${space}Remember${space}`), JSON.stringify(space)).toBe("remember");
    }
    expect(skillNameKey("Re member")).toBe("re member");
  });

  it("is the key the resolver finds a skill by, so a padded name stands in for a built-in", () => {
    const builtin = { name: "Remember", source: "builtin" };
    for (const space of SPACES) {
      const padded = { name: `${space}remember${space}`, source: "user" };
      expect(findSkillByName([padded], "Remember")).toBe(padded);
      expect(mergeBuiltinSkills([builtin], [padded])).toEqual([padded]);
    }
  });
});
