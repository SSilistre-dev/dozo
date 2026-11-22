import { describe, expect, it } from "vitest";
import { dozoAvatarForSave } from "../dozo-avatar-upload.js";
import { dozoBotOrGroupOnly } from "../dozo-chat-target.js";
import { requireBotRunEditor, requireGroupRemover } from "./dozo-bot-edit.js";
import * as hub from "./dozo-bot-routes.js";
import { switchBotComputerWithFiles } from "./dozo-computer-switch.js";

describe("the bots route's one import from the fork", () => {
  it("is each helper the rules call, not a copy", () => {
    expect({ ...hub }).toEqual({
      dozoAvatarForSave,
      dozoBotOrGroupOnly,
      requireBotRunEditor,
      requireGroupRemover,
      switchBotComputerWithFiles,
    });
  });
});
