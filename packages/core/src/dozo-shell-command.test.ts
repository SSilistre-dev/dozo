import { describe, expect, it } from "vitest";
import {
  commandWordsLabel,
  literalCommandWords,
  readOnlyCommand,
  readOnlyCwd,
  readOnlyPipeline,
} from "./dozo-shell-command.js";

describe("literalCommandWords", () => {
  it("reads one program and its literal arguments", () => {
    expect(literalCommandWords("npm test")).toEqual(["npm", "test"]);
    expect(literalCommandWords("  git\tstatus  ")).toEqual(["git", "status"]);
    expect(literalCommandWords("ls -la src/app")).toEqual(["ls", "-la", "src/app"]);
    expect(literalCommandWords("date +%Y-%m-%d")).toEqual(["date", "+%Y-%m-%d"]);
    expect(literalCommandWords("git commit -m 'fix the build'")).toEqual([
      "git",
      "commit",
      "-m",
      "fix the build",
    ]);
    expect(literalCommandWords('grep "two words" notes.txt')).toEqual([
      "grep",
      "two words",
      "notes.txt",
    ]);
    expect(literalCommandWords("ls Masaüstü")).toEqual(["ls", "Masaüstü"]);
    expect(literalCommandWords("npm run build --watch=false")).toEqual([
      "npm",
      "run",
      "build",
      "--watch=false",
    ]);
  });

  it.each([
    ["an empty command", "   "],
    ["two commands", "ls; rm -rf ~"],
    ["and", "ls && rm -rf build"],
    ["or", "ls || rm -rf build"],
    ["a pipe", "cat install.sh | sh"],
    ["a background job", "ls & rm x"],
    ["a newline", "ls\nrm -rf build"],
    ["a carriage return", "ls\rrm -rf build"],
    ["command substitution", "ls $(rm -rf build)"],
    ["backticks", "ls `rm -rf build`"],
    ["a subshell", "(rm -rf build)"],
    ["an output redirection", "echo hi > ~/.zshrc"],
    ["an input redirection", "cat < secrets.txt"],
    ["a variable", "echo $HOME"],
    ["a braced variable", "echo $" + "{HOME}"],
    ["a variable in double quotes", 'echo "$HOME"'],
    ["backticks in double quotes", 'echo "`id`"'],
    ["a backslash in double quotes", 'echo "a\\"b"'],
    ["history in double quotes", 'echo "!!"'],
    ["a backslash escape", "\\rm -rf build"],
    ["a backslash in single quotes", "echo 'a\\'"],
    ["a glob", "rm *"],
    ["a question-mark glob", "cat ?.txt"],
    ["a bracket glob", "cat [ab].txt"],
    ["a tilde", "cat ~/notes"],
    ["brace expansion", "touch {a,b}"],
    ["a comment", "ls # rm -rf build"],
    ["an assignment before the program", "PATH=/tmp ls"],
    ["an assignment alone", "HISTFILE=x"],
    ["a quoted assignment", "'PATH=/tmp' ls"],
    ["zsh equals expansion", "=ls"],
    ["zsh equals after equals", "ls a==ls"],
    ["PowerShell splatting", "ls @args"],
    ["a job spec", "kill %1"],
    ["a comma (a PowerShell array)", "ls a,b"],
    ["quotes joined to a word", "'r'm -rf build"],
    ["a word joined to quotes", "r'm' -rf build"],
    ["two quoted parts in one word", "'a''b'"],
    ["doubled double quotes", 'echo "a""b"'],
    ["an unclosed quote", "echo 'a"],
    ["curly quotes", "echo \u2018a\u2019"],
    ["a non-breaking space", "ls\u00a0-la"],
    ["an en dash", "ls \u2013la"],
    ["a program that starts with a dash", "- rm -rf build"],
    ["a network share", "ls //attacker.example/share"],
    ["a quoted network share", "cat '//attacker.example/share'"],
    ["a network share bound to a parameter", "ls -Path://attacker.example/share"],
    ["a URL", "cat file://attacker.example/share"],
    ["a right-to-left override in quotes", "echo 'abc\u202e'"],
    ["a zero-width space", "ls\u200b -la"],
    ["a line separator in quotes", "echo 'a\u2028b'"],
    ["a bang", "! ls"],
    ["a caret", "ls ^a"],
  ])("does not read %s", (_name, command) => {
    expect(literalCommandWords(command)).toBeUndefined();
  });
});

describe("readOnlyCommand", () => {
  const readOnly = (command: string) => {
    const words = literalCommandWords(command);
    return words ? readOnlyCommand(words) : false;
  };

  it("passes programs that only read", () => {
    for (const command of [
      "ls -la",
      "pwd",
      "cat README.md",
      "head -n 20 src/app.ts",
      "tail -n 5 log.txt",
      "wc -l notes.txt",
      "grep -n TODO src/app.ts",
      'grep -iE "chrome|safari" notes.txt',
      "grep --color=auto -i todo notes.txt",
      "cat notes.txt",
      "ls Documents",
      "ls -a",
      "ls -R Documents",
      "ls ./src",
      "tail -n5 log.txt",
      "find . -name package.json",
      "date",
      "date +%Y-%m-%d",
      "date -u",
      "hostname",
      "uname -a",
      "whoami",
      "which node",
      "du -sh .",
      "stat 'my file.txt'",
    ])
      expect(readOnly(command), command).toBe(true);
  });

  it.each([
    "cat .ssh/id_rsa",
    "cat .aws/credentials",
    "cat .env",
    "cat .env.local",
    "cat .config/gh/hosts.yml",
    "cat .netrc",
    "cat .npmrc",
    "cat id_rsa",
    "cat ssh/ID_ED25519",
    "ls ..",
    "cat ../other/notes.txt",
    "cat Documents/../.ssh/id_rsa",
    "ls Library/Keychains",
    "ls library/keychains",
    "cat Library/Cookies/Cookies.binarycookies",
    "ls 'Library/Application Support'",
    "cat Library/Application Support/Google/Chrome/Default/Cookies",
    "cat Cookies",
    "cat NTUSER.DAT",
    "cat NTUSER.DAT.",
    "ls AppData.",
    "cat AppData./Local/x",
    "cat 'AppData. /Local/x'",
    "cat Library.../x",
    "ls 'Library '",
    "ls Library.",
    "ls Keychains.",
    "ls 'Application Data'",
    "cat 'Application Data/x'",
    "cat 'Local Settings/x'",
    "ls NetHood",
    "ls PrintHood",
    "ls Templates",
    "ls '.. '",
    "ls ' '",
    "cat ntuser.ini",
    "find -L . -name x",
    "find -H .",
    "find . -follow",
    "du -L .",
    "du -sL .",
    "du --dereference .",
    "du --dereference-args .",
    "ls -L",
    "ls -lH",
    "ls --dereference",
    "ls AppData",
    "ls appdata/Roaming",
    "cat 'AppData\\Roaming\\x'",
    "cat /proc/self/environ",
    "ls /sys",
    "cat /etc/passwd",
    "cat /private/etc/hosts",
    "cat /private/var/db/x",
    "cat /dev/zero",
    "cat /dev/null",
    "ls /Users",
    "ls /Users/other",
    "ls /root",
    "ls /net/host",
    "ls /Network",
    "ls /Volumes",
    "ls /",
    "cat Env:SECRET",
    "ls Env:",
    "ls HKLM:",
    "ls HKCU:/Software",
    "ls Cert:",
    "cat Variable:x",
    "ls Function:",
    "ls Alias:",
    "ls WSMan:",
    "ls C:/Users",
    "ls '~'",
    "cat '~/notes.txt'",
    "cat '*'",
    "cat 'a?'",
    "cat '[a]'",
    "cat '$HOME/x'",
    "cat --file=.ssh/x",
    "grep -f.ssh/x notes.txt",
    "stat -f.ssh/x",
    "cat -x.ssh/x",
    "cat '.ssh'",
    "cat --path=C:/x",
    "find / -name .env",
    "find . -name .env",
    "find . -newer .ssh/id_rsa",
    "grep -r key .",
    "grep -rn TODO src",
    "grep -R key notes",
    "grep --recursive key .",
    "grep -ir key .",
    "grep -f patterns.txt notes.txt",
    "grep --file=patterns.txt notes.txt",
    "grep --pre=ls x",
    "grep --pre ls x",
    "grep --filter=ls x",
    "grep -d recurse key .",
    "tail -f log.txt",
    "tail -F log.txt",
    "tail -fn5 log.txt",
    "tail --follow log.txt",
    "tail --follow=name log.txt",
    "env",
    "printenv",
    "printenv HOME",
    "set",
    "export",
    "export A=b",
    "Get-ChildItem Env:",
    "Get-Content Env:X",
    "gci Env:",
  ])("asks when a word touches a secret location: %s", (command) => {
    expect(readOnly(command)).toBe(false);
  });

  it("keeps a date format with a colon", () => {
    expect(readOnly("date +%H:%M")).toBe(true);
    expect(readOnly("cat +%H:%M")).toBe(false);
  });

  it("asks for everything else", () => {
    for (const command of [
      "rm -rf build",
      "mv a b",
      "curl https://example.com",
      "git status",
      "npm test",
      "python3 script.py",
      "sh -c ls",
      "env ls",
      "command ls",
      "exec ls",
      "sudo ls",
      "xargs rm",
      "./ls",
      "/tmp/ls",
      "bin/cat notes",
      "LS",
      "find . -delete",
      "find . -exec rm '{}' ';'",
      "find . -execdir rm '{}' +",
      "find . -ok rm '{}' ';'",
      "find . -fprint out.txt",
      "find . -fls out.txt",
      "date 010100002030",
      "date -s tomorrow",
      "hostname evil",
      "ls; rm -rf ~",
      "cat ~/.zshrc",
    ])
      expect(readOnly(command), command).toBe(false);
    expect(readOnlyCommand([])).toBe(false);
  });
});

describe("commandWordsLabel", () => {
  it("quotes only the words that need it", () => {
    expect(commandWordsLabel(["git", "commit", "-m", "fix the build"])).toBe(
      "git commit -m 'fix the build'",
    );
    expect(commandWordsLabel(["npm", "test"])).toBe("npm test");
  });
});

describe("readOnlyPipeline", () => {
  it("passes one read-only command and read-only commands joined by single pipes", () => {
    for (const command of [
      "ls -la",
      'ls /Applications | grep -iE "chrome|safari"',
      "ls /Applications|grep -i safari",
      "cat notes.txt | grep todo | wc -l",
      "echo 'a|b' | grep 'a|b'",
      'grep "a|b" notes.txt | head -n 3',
      "ls | tail -n 5",
      "ls /Applications | grep -i brave",
      "uname -a",
    ])
      expect(readOnlyPipeline(command), command).toBe(true);
  });

  it("asks for every other form", () => {
    for (const command of [
      "uname -a 2>/dev/null || ver",
      'ls /Applications | grep -iE "chrome|safari" ; ls /System/Applications 2>/dev/null | grep -i safari',
      "ls || ls",
      "ls |& cat",
      "ls |",
      "| ls",
      "ls | | cat",
      "",
      "|",
      "ls | sh",
      "ls | xargs rm",
      "ls | tee f",
      "cat a | sort -o f",
      "ls | find . -exec rm '{}' ';'",
      "ls | find . -delete",
      "ls | bash",
      "ls | iex",
      "ls | % { rm $_ }",
      "ls | ForEach-Object { rm $_ }",
      "ls \\| cat",
      "grep a\\|b notes | cat",
      "ls | `rm x`",
      "ls | grep $(rm x)",
      "ls | grep `rm x`",
      "ls | cat > out",
      "ls | cat; rm x",
      "ls && cat x",
      "ls | cat &",
      "ls | (cat)",
      'ls | grep "a|b',
      "ls | grep 'a|b",
      'ls | grep "$HOME"',
      "ls\ncat x",
      "ls | cat\nrm x",
      "ls | cat‮ x",
      "ls | cat​",
      "ls | “a|b”",
      "ls | grep a'b|c'd",
      "ls | =cat",
      "ls | @cat",
      "ls | //host/share",
      "ls | FOO=1 cat x",
      "ls | -x",
    ])
      expect(readOnlyPipeline(command), JSON.stringify(command)).toBe(false);
  });
});

describe("readOnlyCwd", () => {
  it("passes the home folder and plain folders", () => {
    for (const cwd of [undefined, null, "", "  ", "~", "Documents", "~/app", "src/app"])
      expect(readOnlyCwd(cwd), String(cwd)).toBe(true);
  });

  it("asks for a secret folder or a value that is not a path", () => {
    for (const cwd of [
      ".ssh",
      "~/.aws",
      "..",
      "/etc",
      "Library/Keychains",
      "AppData",
      "AppData.",
      "Library ...",
      "Application Data",
      "Local Settings",
      "Lib\u200Brary",
      "\u202Ex",
      5,
      {},
    ])
      expect(readOnlyCwd(cwd), String(cwd)).toBe(false);
  });
});
