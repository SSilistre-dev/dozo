// What the bots route file takes from the fork, through one import: every anchored rule in
// dozo/brand/brand.json that reaches `routes/bots.ts` goes through here, so the file grows by one
// line and stays under the repository's 1000-line limit for a source file.
export { dozoAvatarForSave } from "../dozo-avatar-upload.js";
export { dozoBotOrGroupOnly } from "../dozo-chat-target.js";
export { botModelPicked } from "../dozo-model-picked.js";
export { requireBotRunEditor, requireGroupRemover } from "./dozo-bot-edit.js";
export { switchBotComputerWithFiles } from "./dozo-computer-switch.js";
