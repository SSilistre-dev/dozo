/**
 * How a member's command rules match a command a bot is about to run, on their own computer or on
 * the bot's computer. Kept apart from dozo-shell-command.ts, which decides what a command is; this
 * file only compares it with the rules.
 */
import { literalCommandWords } from "./dozo-shell-command.js";

/**
 * What a rule does: `allow` runs exactly these words, `allow_prefix` runs these words followed by
 * any literal arguments, `block` refuses any command that contains these words, in every mode.
 */
export const DOZO_COMMAND_RULE_EFFECTS = ["allow", "allow_prefix", "block"] as const;
export type DozoCommandRuleEffect = (typeof DOZO_COMMAND_RULE_EFFECTS)[number];

/** Where a rule was saved: the member's own computer or the bot's computer. */
export type DozoCommandComputer = "user" | "hosted";

export type DozoCommandRuleView = {
  words: readonly string[];
  cwd: string;
  effect: DozoCommandRuleEffect;
  computer: DozoCommandComputer;
};

/**
 * Programs that run another program, a script or code given in their arguments. A prefix rule for
 * one of them would allow anything, so the rule stays exact.
 */
const RUNNERS = new Set([
  "awk",
  "bash",
  "builtin",
  "bun",
  "bunx",
  "busybox",
  "chroot",
  "chrt",
  "cmd",
  "command",
  "dash",
  "deno",
  "doas",
  "env",
  "eval",
  "exec",
  "fish",
  "flock",
  "gawk",
  "ionice",
  "java",
  "ksh",
  "lua",
  "mawk",
  "nawk",
  "nice",
  "node",
  "nohup",
  "npx",
  "nsenter",
  "osascript",
  "perl",
  "php",
  "pkexec",
  "pnpx",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "ruby",
  "runuser",
  "script",
  "sed",
  "setsid",
  "sh",
  "ssh",
  "stdbuf",
  "strace",
  "su",
  "sudo",
  "systemd-run",
  "taskset",
  "tclsh",
  "tcsh",
  "time",
  "timeout",
  "unshare",
  "uvx",
  "watch",
  "xargs",
  "zsh",
]);

/**
 * Subcommands that install or run code their arguments name, or that the project defines (a
 * package's install and run scripts, a submodule's commands, a container's command).
 */
const RUNNER_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  git: ["bisect", "config", "filter-branch", "rebase", "submodule"],
  npm: ["add", "ci", "exec", "i", "install", "run", "run-script", "x"],
  pnpm: ["add", "dlx", "exec", "i", "install", "run"],
  yarn: ["add", "dlx", "exec", "install", "run"],
  pip: ["install"],
  pip3: ["install"],
  docker: ["exec", "run"],
  podman: ["exec", "run"],
  kubectl: ["exec", "run"],
  cargo: ["install", "run"],
  go: ["generate", "install", "run"],
  uv: ["run", "tool"],
};

/** A program word as a shell finds it: its last path part, without case or a Windows `.exe`. */
function programName(word: string): string {
  return word
    .split(/[/\\]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, "");
}

/**
 * Whether these words may be allowed with any arguments after them: at least a program and one
 * word, a program that does not run what its arguments name, and not one of its subcommands that
 * does.
 */
export function prefixRuleAllowed(words: readonly string[]): boolean {
  const [program, subcommand] = words;
  if (!program || subcommand === undefined) return false;
  const name = programName(program);
  if (RUNNERS.has(name) || /^python\d/.test(name)) return false;
  return !RUNNER_SUBCOMMANDS[name]?.includes(subcommand.toLowerCase());
}

/**
 * Whether an allow rule runs this command: the command must read as one literal program and its
 * words (dozo-shell-command.ts), so a command that chains, substitutes, redirects, expands or sets
 * a variable is never allowed by a rule. An exact rule needs the same words. A prefix rule needs
 * them first, followed only by words that are not options or settings (nothing starting with `-`,
 * no `=`): either can make a program run another one (`git -c alias.x=!sh`, `find -exec`,
 * `make all SHELL=/tmp/x`). Same folder only.
 */
function allows(rule: DozoCommandRuleView, words: readonly string[], cwd: string): boolean {
  if (rule.effect === "block" || rule.cwd !== cwd) return false;
  if (rule.effect === "allow") return sameWords(rule.words, words);
  const extra = words.slice(rule.words.length);
  return (
    prefixRuleAllowed(rule.words) &&
    words.length >= rule.words.length &&
    sameWords(rule.words, words.slice(0, rule.words.length)) &&
    extra.every((word) => !word.startsWith("-") && !word.includes("="))
  );
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

/** Invisible format marks, which a shell keeps but a person cannot see. */
const FORMAT = /[\p{Cf}\u2028\u2029]/gu;
/** Marks that end one command and start another in some shell, or open a nested one. */
const COMMAND_BREAKS = /[;&|`()\p{Cc}\u2028\u2029]+/u;
/** Marks that split a command into words in some shell. */
const WORD_BREAKS = /[\s$={},<>]+/u;

/**
 * The commands a person would read in a command line, each as its words, however it is quoted,
 * escaped or wrapped: invisible marks and quotes are dropped, a line continued with a backslash is
 * joined, the text is folded to its plain letters (NFKC: a full-width `ｇｉｔ` is `git`), and it
 * splits on every mark a shell uses between commands and then between words. Each word is kept as
 * a program name, both with its backslashes dropped (an escape, `gi\t`) and read as a Windows path.
 */
function looseCommands(command: string): string[][][] {
  return (
    command
      .normalize("NFKC")
      .replace(FORMAT, "")
      .replace(/\\\r?\n/g, "")
      .replace(/['"]/g, "")
      // A tab only separates words; every other control character ends a command.
      .replace(/\t/g, " ")
      .split(COMMAND_BREAKS)
      .map((part) =>
        part
          .split(WORD_BREAKS)
          .filter(Boolean)
          .map((word) => [programName(word.replace(/\\/g, "")), programName(word)]),
      )
      .filter((words) => words.length > 0)
  );
}

/** A short option, or several run together (`-rf`), as the single options it holds. */
const SHORT_OPTIONS = /^-[a-z0-9]+$/;
const shortOptions = (word: string) =>
  word.length > 2 ? [...word.slice(1)].map((letter) => `-${letter}`) : [word];

/** Text a shell expands into other words: a variable, a substitution, a glob. */
const INDIRECTION = /[$`*?[]/;

/**
 * Whether a block rule matches one command of the line: its words appear in order, with anything
 * between them, and its short options anywhere after its program in any order or grouping (`rm -rf`
 * matches `rm -fr` and `rm -r -f`). It reads through `bash -c '…'`, `sudo`, `env X=1`, options
 * between the words (`git --no-pager push`), quotes, escapes (`g''it`, `gi\t`), paths
 * (`/usr/bin/git`), case and `.exe`. When the line expands text a shell would turn into other words
 * (`git $(echo push)`, `git ${x:-push}`, `git pu*h`), the rule's program alone is enough. This errs
 * toward refusing (`echo git push` is refused too); it does not follow aliases or scripts.
 */
function blocks(
  rule: DozoCommandRuleView,
  commands: readonly string[][][],
  indirect: boolean,
): boolean {
  if (rule.effect !== "block") return false;
  const want = looseCommands(rule.words.join(" "))
    .flat()
    .map(([name]) => name!);
  const words = want.filter((word) => !SHORT_OPTIONS.test(word));
  const options = want.filter((word) => SHORT_OPTIONS.test(word)).flatMap(shortOptions);
  if (!words.length) return false;
  return commands.some((command) => {
    let next = 0;
    const seen = new Set<string>();
    for (const forms of command) {
      if (next === 0 && !forms.includes(words[0]!)) continue;
      if (next === 0 && indirect) return true;
      if (next < words.length && forms.includes(words[next]!)) next++;
      for (const form of forms)
        if (SHORT_OPTIONS.test(form)) for (const option of shortOptions(form)) seen.add(option);
    }
    return next === words.length && options.every((option) => seen.has(option));
  });
}

/**
 * What the member's rules say about a command: `block` when a block rule matches (checked first, on
 * either computer and in any folder), `allow` when an exact allow rule runs it in this folder,
 * `allow_prefix` when only a prefix rule does, otherwise nothing. On the member's own computer only
 * rules saved there allow. On the bot's computer an exact rule saved on their own computer allows
 * too, since that computer holds less of theirs; a prefix rule stays where it was saved.
 */
export function matchCommandRules(
  rules: readonly DozoCommandRuleView[],
  command: { command: string; cwd: string; computer: DozoCommandComputer },
): "block" | "allow" | "allow_prefix" | undefined {
  const commands = looseCommands(command.command);
  const indirect = INDIRECTION.test(command.command);
  if (rules.some((rule) => blocks(rule, commands, indirect))) return "block";
  const words = literalCommandWords(command.command);
  if (!words) return undefined;
  const usable = rules.filter(
    (rule) =>
      rule.computer === command.computer ||
      (command.computer === "hosted" && rule.effect === "allow"),
  );
  const matched = usable.filter((rule) => allows(rule, words, command.cwd));
  if (matched.some((rule) => rule.effect === "allow")) return "allow";
  return matched.length ? "allow_prefix" : undefined;
}
