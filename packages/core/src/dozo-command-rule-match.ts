/**
 * How a member's command rules match a command a bot is about to run, on their own computer or on
 * the bot's computer. Kept apart from dozo-shell-command.ts, which decides what a command is; this
 * file only compares it with the rules.
 */
import { literalCommandWords, readableWord, readOnlyCwd } from "./dozo-shell-command.js";

/**
 * What a rule does: `allow` runs exactly these words, `allow_prefix` runs these words followed by
 * more plain words (only for the commands `prefixRuleAllowed` lists), `block` refuses any command
 * that contains these words, in every mode.
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
 * The commands whose plain arguments (no options, no settings) only name what to read or print, so
 * a rule may allow them with more arguments. Everything else is allowed exactly or not at all: an
 * unknown program, an editor or pager that can run commands, a program that writes where its
 * arguments say (`cp`, `mv`, `tee`, `rm`, `chmod`), a transfer, a build, any Windows program, a
 * test runner (its argument picks the file it runs: `pytest evil.py`), and git (a repository the
 * bot can edit can make `git status` or `git diff` run a program through its configuration or
 * hooks). They are also PowerShell's aliases of cmdlets that only read (`ls`, `cat`, `echo`).
 */
const PREFIX_PROGRAMS: ReadonlySet<string> = /* @__PURE__ */ new Set([
  "basename",
  "cat",
  "cmp",
  "df",
  "diff",
  "dirname",
  "du",
  "echo",
  "file",
  "grep",
  "head",
  "ls",
  "pwd",
  "readlink",
  "realpath",
  "stat",
  "tail",
  "tree",
  "wc",
  "which",
]);

/**
 * Whether these words may be allowed with more arguments after them: the program, by its plain
 * name, is one of `PREFIX_PROGRAMS`, and the folder the rule is for is not a secret place
 * (`readOnlyCwd`: `.ssh`, `.aws`, Library, an absolute path outside the system folders).
 */
export function prefixRuleAllowed(words: readonly string[], cwd = ""): boolean {
  const [program] = words;
  return program !== undefined && PREFIX_PROGRAMS.has(program) && readOnlyCwd(cwd);
}

/**
 * Whether an allow rule runs this command: the command must read as one literal program and its
 * words (dozo-shell-command.ts), so a command that chains, substitutes, redirects, expands or sets
 * a variable is never allowed by a rule. An exact rule needs the same words. A prefix rule needs
 * them first, followed only by words that are neither options nor settings (nothing starting with
 * `-`, no `=`) and that pass the read-only gate's check for secret places (no absolute path outside
 * the system folders, no `..`, no hidden or private location, no drive). Same folder only.
 */
function allows(rule: DozoCommandRuleView, words: readonly string[], cwd: string): boolean {
  if (rule.effect === "block" || rule.cwd !== cwd) return false;
  if (rule.effect === "allow") return sameWords(rule.words, words);
  const extra = words.slice(rule.words.length);
  return (
    prefixRuleAllowed(rule.words, rule.cwd) &&
    words.length >= rule.words.length &&
    sameWords(rule.words, words.slice(0, rule.words.length)) &&
    extra.every(
      (word) => !word.startsWith("-") && !word.includes("=") && readableWord(word, words[0]!),
    )
  );
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

/** A program word as a shell finds it: its last path part, without case or a Windows `.exe`. */
function programName(word: string): string {
  return word
    .split(/[/\\]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, "");
}

/**
 * A path word as a block compares it: without case, `.` and `name/..` parts, or a trailing `/` or
 * `\\`, so `./x/../build/` is `build`; a path of slashes alone stays the root `/`, and a `..` that
 * climbs out of the folder stays (`../build` is another folder).
 */
function pathName(word: string): string {
  const path = word.toLowerCase();
  const rooted = /^[/\\]/.test(path);
  const parts: string[] = [];
  for (const part of path.split(/[/\\]+/)) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !rooted) parts.push(part);
  }
  const joined = parts.join("/");
  return rooted ? `/${joined}` : joined || ".";
}

/** Long options that mean the same as a short one in the programs blocks are usually set for. */
const LONG_OPTIONS: Readonly<Record<string, string>> = {
  "--recursive": "-r",
  "--force": "-f",
  "--force-with-lease": "-f",
  "--force-if-includes": "-f",
  "--delete": "-d",
};
/** A short option, or several run together (`-rf`), as the single options it holds. */
const SHORT_OPTIONS = /^-[a-z0-9]+$/;

/** The single short options a word stands for: `-rf`, `--force`, and a forced git ref `+main`. */
function optionsOf(word: string): string[] {
  const option = LONG_OPTIONS[word] ?? word;
  if (SHORT_OPTIONS.test(option))
    return option.length > 2 ? [...option.slice(1)].map((letter) => `-${letter}`) : [option];
  return /^\+[^%+]/.test(word) ? ["-f"] : [];
}

/** Invisible format marks, which a shell keeps but a person cannot see. */
const FORMAT = /[\p{Cf}\u2028\u2029]/gu;
/** Marks that end one command and start another in some shell, or open a nested one. */
const COMMAND_BREAKS = /[;&|`()\p{Cc}\u2028\u2029]+/u;
/** Marks that split a command into words in some shell. */
const WORD_BREAKS = /[\s$={},<>]+/u;
/** A word a shell fills in when it runs the line: a variable or a substitution. */
const EXPANSION = "\uE000";
/** Glob marks written inside quotes, which no POSIX shell expands, kept apart from real globs. */
const QUOTED: Readonly<Record<string, string>> = { "*": "\uE001", "?": "\uE002", "[": "\uE003" };
const UNQUOTED = /* @__PURE__ */ Object.fromEntries(
  Object.entries(QUOTED).map(([mark, kept]) => [kept, mark]),
);

type LooseWord = {
  /** The word as a program name and as a path, with its backslashes dropped and kept. */
  names: string[];
  paths: string[];
  /** A variable or substitution: it can be any words. */
  expansion: boolean;
  /** An unquoted glob, as the words it can match. */
  glob?: RegExp;
};

function looseWord(word: string): LooseWord {
  const plain = word.replace(/[\uE001-\uE003]/g, (kept) => UNQUOTED[kept]!);
  const forms = [plain.replace(/\\/g, ""), plain];
  const glob = /[*?[]/.test(word)
    ? new RegExp(
        `^${[...pathName(word.replace(/\\/g, ""))]
          .map((char) =>
            char === "*"
              ? ".*"
              : char === "?"
                ? "."
                : char.replace(/[.+^${}()|[\]\\\uE001-\uE003]/g, "\\$&"),
          )
          .join("")
          .replace(/[\uE001-\uE003]/g, (kept) => `\\${UNQUOTED[kept]}`)}$`,
      )
    : undefined;
  return {
    names: forms.map(programName),
    paths: forms.map(pathName),
    expansion: word.includes(EXPANSION),
    ...(glob ? { glob } : {}),
  };
}

/**
 * The commands a person would read in a command line, each as its words, however it is quoted,
 * escaped or wrapped: invisible marks and quotes are dropped, a line continued with a backslash is
 * joined, the text is folded to its plain letters (NFKC: a full-width `ｇｉｔ` is `git`), and it
 * splits on every mark a shell uses between commands and then between words. A variable or a
 * substitution becomes one word that can be anything; a glob outside quotes, a word that can match.
 */
function looseCommands(command: string): LooseWord[][] {
  return (
    command
      .normalize("NFKC")
      .replace(FORMAT, "")
      .replace(/\\\r?\n/g, "")
      .replace(/\$(\{[^}]*\}|'[^']*'|\(|[\w@*#?!$-])/g, (found) =>
        found === "$(" ? ` ${EXPANSION} (` : ` ${EXPANSION} `,
      )
      .replace(/`/g, ` ${EXPANSION} \``)
      .replace(/'([^']*)'|"([^"]*)"/g, (_quoted, single?: string, double?: string) =>
        (single ?? double ?? "").replace(/[*?[]/g, (mark) => QUOTED[mark]!),
      )
      .replace(/['"]/g, "")
      // A tab only separates words; every other control character ends a command.
      .replace(/\t/g, " ")
      .split(COMMAND_BREAKS)
      .map((part) => part.split(WORD_BREAKS).filter(Boolean).map(looseWord))
      .filter((words) => words.length > 0)
  );
}

/**
 * Whether a block rule matches one command of the line. From its program (by name: `/usr/bin/git`,
 * `GIT`, `git.exe`, `gi\t`), its other words follow in order with anything between them (`git
 * --no-pager push`), compared as paths (`./build/` is `build`), and its short options appear in
 * any order or grouping, long or short (`rm -rf` matches `rm -fr`, `rm -r --force`; `git push -f`
 * matches `--force-with-lease` and `+main`). A variable or substitution after the program can be
 * the rest (`git $(echo push)`), and a glob can be a word it matches (`git pu*h`). It reads through
 * `bash -c '…'`, `sudo`, `env X=1` and quotes, and errs toward refusing (`echo git push` is refused
 * too). A best effort, not a boundary: it does not follow a program name built from variables
 * (`$X$Y`), `eval`, encoded text, aliases or scripts.
 */
function blocks(rule: DozoCommandRuleView, commands: readonly LooseWord[][]): boolean {
  if (rule.effect !== "block") return false;
  const want = looseCommands(rule.words.join(" ")).flat();
  const [program, ...rest] = want;
  if (!program) return false;
  const name = program.names[0]!;
  const options = rest.flatMap((word) => optionsOf(word.paths[0]!));
  const words = rest
    .filter((word) => !optionsOf(word.paths[0]!).length)
    .map((word) => word.paths[0]!);
  return commands.some((command) =>
    command.some((word, at) => {
      if (word.expansion || !word.names.includes(name)) return false;
      let next = 0;
      const seen = new Set<string>();
      for (const later of command.slice(at + 1)) {
        if (later.expansion) return true;
        const wanted = words[next];
        if (wanted !== undefined && (later.paths.includes(wanted) || later.glob?.test(wanted)))
          next++;
        for (const option of optionsOf(later.paths[0]!)) seen.add(option);
      }
      return next === words.length && options.every((option) => seen.has(option));
    }),
  );
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
  if (rules.some((rule) => blocks(rule, commands))) return "block";
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
