/**
 * How a command for the user's own computer is read before it runs, to decide whether it asks.
 *
 * The server does not know which shell the computer runs it in (a POSIX shell, fish or
 * PowerShell), so a command is read only when it is plain in all of them: one program and its
 * arguments, each a literal word. Anything a shell could expand, chain, redirect or read
 * differently is not read at all, and a command that is not read always asks.
 */

/** Characters a word may hold outside quotes: letters, digits and a few marks no shell reads. */
const PLAIN = /^[\p{L}\p{N}_\-./:@+=%]$/u;
/** Marks with a meaning at the start of a word: zsh `=cmd`, PowerShell `@splat`, job `%1`. */
const NOT_FIRST = new Set(["=", "@", "%"]);
/** Inside double quotes, the characters some shell expands or escapes. */
const DOUBLE_QUOTED_SPECIAL = new Set(["$", "`", "\\", "!"]);
/** Invisible marks that can make a card show text other than what runs (U+202E, for one). */
const FORMAT = /[\p{Cf}\u2028\u2029]/u;

/**
 * Control characters other than a tab, the curly quotes PowerShell reads as quotes, and invisible
 * format marks.
 */
function hasNeverCharacter(command: string): boolean {
  if (FORMAT.test(command)) return true;
  for (const char of command) {
    const code = char.codePointAt(0)!;
    if ((code < 0x20 && char !== "\t") || (code >= 0x7f && code <= 0x9f)) return true;
    if (code >= 0x2018 && code <= 0x201f) return true;
  }
  return false;
}

/**
 * The words of a command that is one program and its literal arguments, with quotes removed, or
 * undefined when the command is anything else: two commands, a pipe, a redirection, a variable, a
 * glob, a subshell, an assignment before the program, or text that is not plain in every shell.
 */
export function literalCommandWords(command: string): string[] | undefined {
  if (hasNeverCharacter(command)) return undefined;
  const words: string[] = [];
  let word: string | undefined;
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!;
    if (char === " " || char === "\t") {
      if (word !== undefined) words.push(word);
      word = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      // A quoted part is a whole word: shells join 'a'b, 'a''b' and a'b' differently.
      const end = command.indexOf(char, at + 1);
      const after = command[end + 1];
      if (word !== undefined || end < 0 || (after !== undefined && after !== " " && after !== "\t"))
        return undefined;
      const inner = command.slice(at + 1, end);
      if (char === "'" && inner.includes("\\")) return undefined;
      if (char === '"' && [...inner].some((c) => DOUBLE_QUOTED_SPECIAL.has(c))) return undefined;
      words.push(inner);
      at = end;
      continue;
    }
    if (!PLAIN.test(char)) return undefined;
    if (word === undefined && NOT_FIRST.has(char)) return undefined;
    // zsh can expand `a==cmd`.
    if (char === "=" && command[at - 1] === "=") return undefined;
    word = (word ?? "") + char;
  }
  if (word !== undefined) words.push(word);
  const program = words[0];
  // `NAME=value cmd` runs cmd with a changed environment (PATH, for one); zsh reads `- cmd`.
  if (!program || program.includes("=") || program.startsWith("-")) return undefined;
  // Windows reaches //host/share over the network, signing in as the user, also from inside a
  // word such as PowerShell's `-Path://host/share`.
  if (words.some((each) => each.includes("//"))) return undefined;
  return words;
}

/** Programs that only read and print, in every shell their name reaches. */
const READ_ONLY_PROGRAMS = new Set([
  "basename",
  "cat",
  "df",
  "dirname",
  "du",
  "echo",
  "grep",
  "head",
  "id",
  "ls",
  "pwd",
  "readlink",
  "realpath",
  "stat",
  "tail",
  "uname",
  "wc",
  "which",
  "whoami",
]);

/** find's actions that run a program, delete, or write a file. */
const FIND_ACTIONS = ["-exec", "-ok", "-delete", "-fprint", "-fls"];

/** Absolute locations a command may name without asking; every other absolute path asks. */
const OPEN_ROOTS = ["/applications", "/system/applications", "/usr", "/bin", "/sbin", "/opt"];
/**
 * Folders and file names that hold secrets or private data, matched on a whole path component
 * (macOS and Windows ignore case).
 */
const PRIVATE_COMPONENTS = new Set(["library", "appdata", "keychains", "cookies", "ntuser"]);
/** File names that hold a private key or a browser's stored data, wherever they sit. */
const KEY_FILE = /^id_(rsa|dsa|ecdsa|ed25519)|keychain|cookies|login data/;

/**
 * Whether a word names, or could reach, a place that holds secrets, so the command asks. These
 * commands run without a card and their output goes to the model, so a word asks when unsure:
 * - a component that starts with a dot other than `.` (`.ssh`, `.aws`, `.env`, `.config`), and any
 *   `..`, which can leave the folder the user chose (simplest sound rule: all of them ask);
 * - a flag that holds a dot (`-f.ssh/x`), since the letters before the value are unknown;
 * - Library, AppData, keychains and cookie files, and key files by name;
 * - a `:` (PowerShell's `Env:`, `HKLM:`, `Cert:` drives, `C:` paths), except in a `date +` format;
 * - `~`, `$`, and a glob character (a shell never reads it when quoted, but PowerShell does);
 * - an absolute path outside `OPEN_ROOTS`, which covers /proc, /sys, /etc, /dev (also /dev/null:
 *   nothing needs it), /private, /net, /Network, /Volumes, /Users and /root.
 * Names alone are not secret: `ls -a`, `ls -R`, `du -a` and `find` print hidden names, never what
 * is inside them, so they pass; `find / -name .env` still asks through `/` and `.env`.
 * A word is read in every segment between `/`, `\`, `=` and other marks, so `--file=.ssh/x` asks.
 */
function touchesSecretLocation(word: string, program: string): boolean {
  const lower = word.toLowerCase().replaceAll("\\", "/");
  if (lower.includes(":") && !(program === "date" && lower.startsWith("+"))) return true;
  if (/[*?[~$]/.test(lower)) return true;
  for (const segment of lower.split("=")) {
    const open = OPEN_ROOTS.some((root) => segment === root || segment.startsWith(`${root}/`));
    if (segment.startsWith("/") && !open) return true;
  }
  if (KEY_FILE.test(lower)) return true;
  return lower
    .split(/[^\p{L}\p{N}_\-.]+/u)
    .some(
      (part) =>
        (part.startsWith(".") && part !== ".") ||
        (part.startsWith("-") && part.includes(".")) ||
        PRIVATE_COMPONENTS.has(part) ||
        KEY_FILE.test(part),
    );
}

/** grep's long options that only change what it prints; any other (`--pre`, `--filter`) asks. */
const GREP_LONG_OPTIONS = new Set([
  "after-context",
  "before-context",
  "color",
  "colour",
  "context",
  "count",
  "extended-regexp",
  "files-with-matches",
  "files-without-match",
  "fixed-strings",
  "ignore-case",
  "invert-match",
  "line-number",
  "max-count",
  "no-filename",
  "no-messages",
  "only-matching",
  "quiet",
  "regexp",
  "silent",
  "with-filename",
  "word-regexp",
]);

/**
 * Arguments that make an otherwise reading program read more than it names or run something.
 * grep: recursion (it would read every hidden file below the folder), `-f` and `-d`/`-D`, and
 * long options outside the list (some greps run a program with `--pre` or `--filter`). tail:
 * `-f`, `-F` and `--follow` wait for the command's own timeout.
 */
function hasRiskyArgument(program: string, args: readonly string[]): boolean {
  const shortLetters = (arg: string) => (/^-[^-]/.test(arg) ? arg.slice(1) : "");
  if (program === "grep")
    return args.some((arg) =>
      arg.startsWith("--")
        ? !GREP_LONG_OPTIONS.has(arg.slice(2).split("=")[0]!)
        : /[rRfdD]/.test(shortLetters(arg)),
    );
  if (program === "tail")
    return args.some((arg) =>
      arg.startsWith("--") ? arg.startsWith("--f") : /[fF]/.test(shortLetters(arg)),
    );
  return false;
}

/**
 * Whether the words run a program that only reads, with no argument that makes it write or run
 * another program, and no word that touches a secret location. The list holds what may pass,
 * never what must ask, so a program it does not know (a script, an interpreter, a copy under
 * another name) asks.
 */
export function readOnlyCommand(words: readonly string[]): boolean {
  const [program, ...args] = words;
  if (!program) return false;
  if (args.some((arg) => touchesSecretLocation(arg, program))) return false;
  if (hasRiskyArgument(program, args)) return false;
  if (READ_ONLY_PROGRAMS.has(program)) return true;
  if (program === "find")
    return !args.some((arg) => FIND_ACTIONS.some((action) => arg.startsWith(action)));
  // `date 0101...` and `hostname name` set the clock and the name.
  if (program === "date") return args.every((arg) => arg.startsWith("+") || arg === "-u");
  if (program === "hostname") return args.length === 0;
  return false;
}

/**
 * The parts of a command split on each `|` outside quotes, skipping quotes exactly as
 * `literalCommandWords` pairs them, so a split never falls inside a quoted word. Undefined when a
 * quote is never closed.
 */
function splitOnPipes(command: string): string[] | undefined {
  const parts: string[] = [];
  let from = 0;
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!;
    if (char === "'" || char === '"') {
      const end = command.indexOf(char, at + 1);
      if (end < 0) return undefined;
      at = end;
    } else if (char === "|") {
      parts.push(command.slice(from, at));
      from = at + 1;
    }
  }
  parts.push(command.slice(from));
  return parts;
}

/**
 * Whether the command is one read-only command, or read-only commands joined by single pipes. Each
 * part must pass `literalCommandWords` and `readOnlyCommand` on its own, so `||`, `|&`, an empty
 * part, a leading or trailing pipe and every other operator fail. None of the listed programs
 * writes a file or runs another program from its input (in PowerShell their names are aliases of
 * cmdlets that only read or print), so a pipe between them only passes text along. `tail -f`
 * waits until the command's own timeout.
 */
export function readOnlyPipeline(command: string): boolean {
  const parts = splitOnPipes(command);
  return !!parts?.every((part) => {
    const words = literalCommandWords(part);
    return words !== undefined && readOnlyCommand(words);
  });
}

/** The words as one line a person can read, quoting the ones that need it. */
export function commandWordsLabel(words: readonly string[]): string {
  return words
    .map((word) => (/^[\p{L}\p{N}_\-./:@+=%]+$/u.test(word) ? word : `'${word}'`))
    .join(" ");
}

/** The folder a command rule is kept for, as the bot named it: '' is the home folder. */
export function commandRuleCwd(cwd: unknown): string {
  const folder = typeof cwd === "string" ? cwd.trim() : "";
  return folder === "~" ? "" : folder;
}
