#!/usr/bin/env node
// Holds the fast gate until someone has read every long-lived mutable state in the fork's server
// code. One process serves many people at once, so a top-level Map, Set, cache, `let` or `globalThis`
// slot whose key is not scoped by user, space, bot, thread or run is where one person's data could
// reach another. Every hit is listed once in dozo/db/module-state-reviewed.tsv with where it lives and
// its key scope; a new one fails, and so does a hit that moved to another level.
//
// Scope of the scan:
//   - the fork's own files (`dozo-*.ts|tsx|mts`) under `apps/api`, `apps/worker` and `packages/*`,
//     except the pure client packages `packages/ui-web` and `packages/chat-ui`, and
//     `packages/testkit` (test support);
//   - every `.ts` file of the relay worker (`dozo/relay/worker/src`), which serves many people's
//     channels from one isolate;
//   - the state the anchored brand rules (`dozo/brand/brand.json`) ADD to upstream files in those
//     roots: the rules are applied to the file's text in memory and only the hits the result has
//     beyond the original are listed (the upstream file's own state is upstream's). Applying the
//     rules is the simple robust way: a `replace` is a fragment that does not parse on its own, and
//     the whole file gives each added line its real level.
// Tests (`*.test|spec.*`), `*.test-support.*`, `*.d.ts`, node_modules, generated, dist, e2e and
// .turbo are skipped. The web, desktop and mobile apps run per person on one device and are not
// scanned.
//
// The source is parsed with the TypeScript compiler API (the version the repo already installs;
// see loadTypeScript), so layout does not matter: multi-line declarations, nesting and comments are
// read as the compiler reads them. A hit is `file`, `where` (the declaration path: `module`,
// `class Cache`, `fn make`, `fn make > class X`, ...) and the first line of the declaration. The
// level is part of the key: a reviewed `local` that moves to module level is a new hit and the old
// row goes stale. What is a hit:
//   module level (also inside a top-level block)
//     - `let` or `var`;
//     - `const` initialised with `new X(...)` (not RegExp, URL, URLSearchParams, TextEncoder,
//       TextDecoder, Date, *Error), a call (not a schema builder `z.*`, `*Schema.*`, `Symbol`,
//       `Object.freeze`, `String`, `Number`, `Boolean`, `JSON.*`, `Math.*`, or a method of an array
//       literal), or an object or array literal that is empty, holds a container (`new Map()`, `{}`,
//       `[]`, a nested literal that does) or whose name is mutated in the file (assignment to a
//       property or element, `++`, `delete`, `push`, `set`, `add`, `delete`, `clear`, `splice`,
//       `Object.assign(x, ...)` ...). `as const` is read-only and passes.
//   class (anywhere): an instance or static property initialiser with the same test, and
//     `this.x = <the same>` in the constructor.
//   top-level function (a factory runs once and lives as long as the process): a `let`/`var`, or a
//     `const` that is `new X()`, an empty or container literal or a call named like a factory
//     (create*, make*, build*, init*, *cache, *store, *pool, *registry, *limiter, *queue, ...), when
//     the name escapes: a nested function other than a synchronous array callback reads it, or
//     the returned object literal that carries functions lists it. A property of such a returned
//     literal that holds a container counts too (`return { cache: new Map(), get() {} }`). A
//     per-call local gets scope `local`.
//   anywhere: an assignment to `globalThis.x` or `global.x` (also `(globalThis as any)[k] ??=`),
//     and `Object.assign|defineProperty(globalThis, ...)`.
// False positives are preferred to misses. Out of scope: state reached only through aliasing, and
// objects another module mutates.
// Usage: node dozo/db/module-state-guard.mjs [--root=DIR] [--write]. Exit 0 ok, 2 an unreviewed hit
// or a stale reviewed row, 64 usage. --write keeps the scope and note of rows that still match, and
// writes `TODO` for new hits (which then fail until a person fills them in).
// Reviewed rows: dozo/db/module-state-reviewed.tsv (file<TAB>where<TAB>line<TAB>scope<TAB>note).
// The parser: the module named by DOZO_TYPESCRIPT, else apps/www or apps/mobile's installed
// `typescript` under --root (the root install is TypeScript 7, which has no parsing API in JS).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEWED = "dozo/db/module-state-reviewed.tsv";
export const SCOPES = [
  "user",
  "space",
  "bot",
  "thread",
  "run",
  "request",
  "token",
  "device",
  "global-safe",
  "local",
];
const ROOTS = ["apps/api", "apps/worker", "packages"];
const RELAY = "dozo/relay/worker/src";
const BRAND = "dozo/brand/brand.json";
const SKIPPED_DIRS = [
  "node_modules",
  "generated",
  "dist",
  "e2e",
  ".turbo",
  "ui-web",
  "chat-ui",
  "testkit",
];
const SOURCE = /\.(ts|tsx|mts)$/;
const NOT_SOURCE = /(\.(test|spec|test-support)\.(ts|tsx|mts)|\.d\.ts)$/;
const IMMUTABLE_NEW =
  /^(RegExp|URL|URLSearchParams|TextEncoder|TextDecoder|Date|Promise|AbortController|ArrayBuffer|\w*Array|\w*Error)$/;
const PURE_ROOT = /^(z|Symbol|String|Number|Boolean|JSON|Math|Promise|\w*Schema)$/;
const FACTORY_NAME =
  /^(create|make|build|init|new)[A-Z_]|(cache|store|pool|registry|limiter|queue|lru|memo|tracker)$/i;
// Calls that return a fresh value derived from their input: state only when written through later.
const DERIVING_CALLS = new Set([
  "map",
  "filter",
  "flatMap",
  "flat",
  "slice",
  "concat",
  "split",
  "toSorted",
  "toReversed",
  "keys",
  "values",
  "entries",
  "fromEntries",
  "from",
]);
const MUTATING_CALLS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "set",
  "add",
  "delete",
  "clear",
  "assign",
  "copyWithin",
]);
const SYNC_CALLBACK_OWNERS = new Set([
  "map",
  "filter",
  "forEach",
  "reduce",
  "reduceRight",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "sort",
  "toSorted",
]);

/** The TypeScript compiler API with a parser (TypeScript 6 or older in the repo's installs). */
export function loadTypeScript(root = ".") {
  const candidates = [
    process.env.DOZO_TYPESCRIPT,
    join(root, "apps/www/node_modules/typescript"),
    join(root, "apps/mobile/node_modules/typescript"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const ts = createRequire(import.meta.url)(candidate);
      if (typeof ts.createSourceFile === "function") return ts;
    } catch {
      // try the next one
    }
  }
  throw new Error(
    `no TypeScript parser found (tried ${candidates.join(", ") || "nothing"}); set DOZO_TYPESCRIPT to a TypeScript 6 install`,
  );
}

function files(root) {
  const found = [];
  const walk = (dir, accept) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.includes(entry.name)) walk(path, accept);
      } else if (SOURCE.test(entry.name) && !NOT_SOURCE.test(entry.name) && accept(entry.name)) {
        found.push(path);
      }
    }
  };
  for (const top of ROOTS) walk(join(root, top), (name) => name.startsWith("dozo-"));
  walk(join(root, RELAY), () => true);
  return found.sort();
}

/** The anchored brand rules by upstream file, for files in the scanned roots that are not fork files. */
function anchoredRules(root) {
  let rules;
  try {
    rules = JSON.parse(readFileSync(join(root, BRAND), "utf8")).anchored ?? [];
  } catch {
    return new Map();
  }
  const byFile = new Map();
  for (const rule of rules) {
    const file = rule.file;
    const name = file.split("/").pop();
    const inRoot = ROOTS.some((top) => file.startsWith(`${top}/`));
    const skipped = file.split("/").some((part) => SKIPPED_DIRS.includes(part));
    if (!inRoot || skipped || !SOURCE.test(file) || NOT_SOURCE.test(file)) continue;
    if (name.startsWith("dozo-")) continue;
    byFile.set(file, [...(byFile.get(file) ?? []), rule]);
  }
  return byFile;
}

const firstLine = (sf, node) => node.getText(sf).split("\n")[0].trim();

/** `where<TAB>first line` of every long-lived mutable state in one file's text. */
export function analyse(ts, fileName, text) {
  const kind = /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const hits = [];
  const add = (path, node) =>
    hits.push(`${path.length ? path.join(" > ") : "module"}\t${firstLine(sf, node)}`);

  const unwrap = (node) => {
    let e = node;
    while (
      e &&
      (ts.isParenthesizedExpression(e) ||
        ts.isNonNullExpression(e) ||
        ts.isTypeAssertionExpression(e) ||
        ts.isSatisfiesExpression(e) ||
        ts.isAwaitExpression(e) ||
        (ts.isAsExpression(e) && !isConstAssertion(e)))
    )
      e = e.expression;
    return e;
  };
  function isConstAssertion(e) {
    return ts.isTypeReferenceNode(e.type) && e.type.typeName.getText(sf) === "const";
  }
  const rootOf = (e) => {
    let x = e;
    for (;;) {
      if (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x))
        x = x.expression;
      else if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x))
        x = x.expression;
      else if (ts.isCallExpression(x)) x = x.expression;
      else return x;
    }
  };
  const calleeName = (call) => {
    const e = call.expression;
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    return "";
  };

  // Names that are written through in this file: `x.a = 1`, `x[k] = v`, `x.n++`, `delete x.a`,
  // `x.push(v)`, `Object.assign(x, ...)`.
  const mutated = new Set();
  const noteRoot = (e) => {
    const r = rootOf(e);
    if (ts.isIdentifier(r)) mutated.add(r.text);
  };
  const scanMutations = (node) => {
    if (ts.isBinaryExpression(node)) {
      const k = node.operatorToken.kind;
      if (
        k >= ts.SyntaxKind.FirstAssignment &&
        k <= ts.SyntaxKind.LastAssignment &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
      )
        noteRoot(node.left.expression);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand))
    )
      noteRoot(node.operand.expression);
    else if (ts.isDeleteExpression(node)) noteRoot(node.expression);
    else if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (ts.isPropertyAccessExpression(e) && MUTATING_CALLS.has(e.name.text)) {
        if (e.name.text === "assign" && e.expression.getText(sf) === "Object") {
          if (node.arguments[0]) noteRoot(node.arguments[0]);
        } else noteRoot(e.expression);
      }
    }
    ts.forEachChild(node, scanMutations);
  };
  scanMutations(sf);

  // `/* @__PURE__ */` is the author's word that the call only builds a value (contract tables).
  const annotatedPure = (call) =>
    text.slice(call.getFullStart(), call.getStart(sf)).includes("@__PURE__");
  const pureCall = (call) => {
    if (annotatedPure(call)) return true;
    const root = rootOf(call.expression);
    if (ts.isArrayLiteralExpression(root)) return true;
    if (!ts.isIdentifier(root)) return false;
    if (root.text === "Object") return calleeName(call) === "freeze";
    return PURE_ROOT.test(root.text);
  };
  const factoryCall = (call) => FACTORY_NAME.test(calleeName(call));
  // A container, or a literal that holds one, however deep.
  const holdsContainer = (node) => {
    const e = unwrap(node);
    if (!e) return false;
    if (ts.isNewExpression(e)) return !IMMUTABLE_NEW.test(calleeNameOfNew(e));
    if (ts.isCallExpression(e)) return factoryCall(e);
    if (ts.isObjectLiteralExpression(e))
      return (
        e.properties.length === 0 ||
        e.properties.some((p) => ts.isPropertyAssignment(p) && holdsContainer(p.initializer))
      );
    if (ts.isArrayLiteralExpression(e))
      return e.elements.length === 0 || e.elements.some((x) => holdsContainer(x));
    return false;
  };
  const calleeNameOfNew = (e) => e.expression.getText(sf).split(".").pop();
  // `level`: "module" (and class fields) read any call; "body" only a call named like a factory.
  const stateful = (node, level, name) => {
    const e = unwrap(node);
    if (!e) return false;
    if (ts.isConditionalExpression(e))
      return stateful(e.whenTrue, level, name) || stateful(e.whenFalse, level, name);
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      if (
        k === ts.SyntaxKind.QuestionQuestionToken ||
        k === ts.SyntaxKind.BarBarToken ||
        k === ts.SyntaxKind.AmpersandAmpersandToken
      )
        return stateful(e.left, level, name) || stateful(e.right, level, name);
      return false;
    }
    if (ts.isNewExpression(e)) return !IMMUTABLE_NEW.test(calleeNameOfNew(e));
    if (ts.isCallExpression(e)) {
      if (DERIVING_CALLS.has(calleeName(e))) return name !== undefined && mutated.has(name);
      return level === "module" ? !pureCall(e) : factoryCall(e);
    }
    if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e))
      return holdsContainer(e) || (name !== undefined && mutated.has(name));
    return false;
  };

  const isBlockScopedFlag = (list, flag) => (list.flags & flag) !== 0;
  const declaredNames = (name) => {
    if (ts.isIdentifier(name)) return [name.text];
    return name.elements.flatMap((el) =>
      ts.isOmittedExpression(el) ? [] : declaredNames(el.name),
    );
  };
  const isAmbient = (statement) =>
    statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);

  // The object literals a function returns that carry functions: a service the caller keeps.
  const returnedServices = (fn) => {
    const found = [];
    const isService = (literal) =>
      ts.isObjectLiteralExpression(literal) &&
      literal.properties.some(
        (p) =>
          ts.isMethodDeclaration(p) ||
          ts.isGetAccessor(p) ||
          (ts.isPropertyAssignment(p) &&
            (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))),
      );
    const look = (node) => {
      if (node !== fn && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
      const expression = ts.isReturnStatement(node) ? node.expression : undefined;
      const literal = expression && unwrap(expression);
      if (literal && isService(literal)) found.push(literal);
      ts.forEachChild(node, look);
    };
    if (fn.body && ts.isBlock(fn.body)) ts.forEachChild(fn.body, look);
    else if (fn.body) {
      const literal = unwrap(fn.body);
      if (isService(literal)) found.push(literal);
    }
    return found;
  };

  // Names a nested function (other than a synchronous array callback) can reach, in one function body.
  const escapingNames = (fn) => {
    const names = new Set();
    const walk = (node, reaches) => {
      if (node !== fn && ts.isFunctionLike(node)) {
        const parent = node.parent;
        const sync =
          parent &&
          ts.isCallExpression(parent) &&
          ts.isPropertyAccessExpression(parent.expression) &&
          SYNC_CALLBACK_OWNERS.has(parent.expression.name.text);
        if (!sync) reaches = true;
      }
      if (ts.isIdentifier(node) && reaches) names.add(node.text);
      if (ts.isShorthandPropertyAssignment(node) && reaches) names.add(node.name.text);
      ts.forEachChild(node, (child) => walk(child, reaches));
    };
    if (fn.body) ts.forEachChild(fn.body, (child) => walk(child, false));
    for (const literal of returnedServices(fn))
      for (const p of literal.properties) {
        if (ts.isShorthandPropertyAssignment(p)) names.add(p.name.text);
        else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer))
          names.add(p.initializer.text);
      }
    return names;
  };

  // A top-level function: state its body creates lives as long as the process when it runs once.
  const checkFactory = (fn, path) => {
    const reach = escapingNames(fn);
    const declarations = (node) => {
      if (node !== fn && (ts.isFunctionLike(node) || ts.isClassLike(node))) return;
      if (ts.isVariableStatement(node)) {
        const list = node.declarationList;
        const one = list.declarations.length === 1;
        for (const d of list.declarations) {
          const names = declaredNames(d.name);
          const isConst = isBlockScopedFlag(list, ts.NodeFlags.Const);
          const candidate =
            !isConst || (d.initializer && stateful(d.initializer, "body", names[0]));
          if (candidate && names.some((n) => reach.has(n))) add(path, one ? node : d);
        }
      }
      ts.forEachChild(node, declarations);
    };
    if (fn.body && ts.isBlock(fn.body)) ts.forEachChild(fn.body, declarations);
    for (const literal of returnedServices(fn))
      for (const p of literal.properties)
        if (ts.isPropertyAssignment(p) && holdsContainer(p.initializer)) add(path, p);
  };

  const nameOfFunction = (fn) => {
    if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
    if (fn.name) return fn.name.getText(sf);
    const parent = fn.parent;
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
      return parent.name.text;
    if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(sf);
    return undefined;
  };
  const nameOfClass = (c) => c.name?.text ?? "<anonymous>";

  const globalRoot = (e) => {
    const r = rootOf(e);
    return ts.isIdentifier(r) && (r.text === "globalThis" || r.text === "global");
  };

  function visit(node, ctx) {
    if (ts.isBinaryExpression(node)) {
      const k = node.operatorToken.kind;
      if (
        k >= ts.SyntaxKind.FirstAssignment &&
        k <= ts.SyntaxKind.LastAssignment &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
        globalRoot(node.left.expression)
      )
        add(ctx.path, node);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (
        (callee === "Object.assign" || callee === "Object.defineProperty") &&
        node.arguments[0] &&
        globalRoot(node.arguments[0])
      )
        add(ctx.path, node);
    }
    if (ts.isClassLike(node)) {
      const path = [...ctx.path, `class ${nameOfClass(node)}`];
      for (const member of node.members) {
        if (ts.isPropertyDeclaration(member) && member.initializer) {
          const name = ts.isIdentifier(member.name) ? member.name.text : undefined;
          if (stateful(member.initializer, "module", name)) add(path, member);
        } else if (ts.isConstructorDeclaration(member) && member.body) {
          const assigned = (n) => {
            if (n !== member && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
            if (
              ts.isBinaryExpression(n) &&
              n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isPropertyAccessExpression(n.left) &&
              n.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
              stateful(n.right, "module", n.left.name.text)
            )
              add(path, n);
            ts.forEachChild(n, assigned);
          };
          ts.forEachChild(member.body, assigned);
        }
      }
      ts.forEachChild(node, (child) => visit(child, { path, inFunction: ctx.inFunction }));
      return;
    }
    if (ts.isFunctionLike(node) && node.body) {
      const name = nameOfFunction(node);
      const path = name ? [...ctx.path, `fn ${name}`] : ctx.path;
      if (!ctx.inFunction) checkFactory(node, path);
      ts.forEachChild(node, (child) => visit(child, { path, inFunction: true }));
      return;
    }
    if (ts.isVariableStatement(node) && !ctx.inFunction && !isAmbient(node)) {
      const list = node.declarationList;
      const one = list.declarations.length === 1;
      for (const d of list.declarations) {
        const isConst = isBlockScopedFlag(list, ts.NodeFlags.Const);
        const names = declaredNames(d.name);
        if (!isConst || (d.initializer && stateful(d.initializer, "module", names[0])))
          add(ctx.path, one ? node : d);
      }
    }
    ts.forEachChild(node, (child) => visit(child, ctx));
  }
  visit(sf, { path: [], inFunction: false });
  return hits;
}

function applyRules(text, rules) {
  let out = text;
  for (const rule of rules) {
    const at = out.indexOf(rule.find);
    if (at >= 0 && out.indexOf(rule.find, at + 1) < 0)
      out = out.slice(0, at) + rule.replace + out.slice(at + rule.find.length);
  }
  return out;
}

/** Every long-lived mutable state, as `file<TAB>where<TAB>first line`. */
export function moduleState(root, ts = loadTypeScript(root)) {
  const hits = [];
  for (const path of files(root)) {
    const file = relative(root, path);
    for (const hit of analyse(ts, file, readFileSync(path, "utf8"))) hits.push(`${file}\t${hit}`);
  }
  for (const [file, rules] of anchoredRules(root)) {
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const left = new Map();
    for (const hit of analyse(ts, file, text)) left.set(hit, (left.get(hit) ?? 0) + 1);
    for (const hit of analyse(ts, file, applyRules(text, rules))) {
      const count = left.get(hit) ?? 0;
      if (count > 0) left.set(hit, count - 1);
      else hits.push(`${file}\t${hit}`);
    }
  }
  return hits;
}

function parseReviewed(text) {
  return text
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [file, where, code, scope = "", note = ""] = line.split("\t");
      return { key: `${file}\t${where}\t${code}`, scope, note };
    });
}

/** Hits beyond the reviewed rows (a row covers one occurrence), rows with no hit left, and bad scopes. */
export function check(root, reviewedText, ts) {
  const rows = parseReviewed(reviewedText);
  const left = new Map();
  for (const row of rows) left.set(row.key, (left.get(row.key) ?? 0) + 1);
  const extra = [];
  for (const hit of moduleState(root, ts)) {
    const count = left.get(hit) ?? 0;
    if (count > 0) left.set(hit, count - 1);
    else extra.push(hit);
  }
  const stale = [...left].flatMap(([key, count]) => Array(count).fill(key));
  const badScope = rows.filter((row) => !SCOPES.includes(row.scope)).map((row) => row.key);
  return { extra, stale, badScope };
}

const HEADER = [
  "# Long-lived mutable state in the fork's server code, each read for its key scope",
  "# (dozo/db/module-state-guard.mjs). Columns: file, where, line, scope, note. Scope is one of",
  `# ${SCOPES.join(", ")}.`,
];

export function main(argv, out = console) {
  let root = ".";
  let write = false;
  for (const arg of argv) {
    if (arg === "--write") write = true;
    else if (arg.startsWith("--root=")) root = arg.slice("--root=".length);
    else {
      out.error("usage: module-state-guard.mjs [--root=DIR] [--write]");
      return 64;
    }
  }
  let ts;
  try {
    ts = loadTypeScript(root);
  } catch (error) {
    out.error(`module state guard FAILED: ${error.message}`);
    return 2;
  }
  let reviewedText = "";
  try {
    reviewedText = readFileSync(join(root, REVIEWED), "utf8");
  } catch {
    if (!write) {
      out.error(`module state guard FAILED: ${REVIEWED} is missing`);
      return 2;
    }
  }
  if (write) {
    const known = new Map(parseReviewed(reviewedText).map((row) => [row.key, row]));
    const rows = moduleState(root, ts).map((hit) => {
      const row = known.get(hit);
      return `${hit}\t${row?.scope || "TODO"}\t${row?.note || "TODO"}`;
    });
    writeFileSync(join(root, REVIEWED), `${[...HEADER, ...rows].join("\n")}\n`);
    out.log(`module state guard: wrote ${REVIEWED}`);
    return 0;
  }
  const { extra, stale, badScope } = check(root, reviewedText, ts);
  if (extra.length + stale.length + badScope.length === 0) {
    out.log("module state guard ok: every long-lived mutable state in server code is reviewed");
    return 0;
  }
  const show = (key) => `  ${key.replace("\t", ": ").replace("\t", ": ")}`;
  out.error(
    [
      "module state guard FAILED:",
      ...(extra.length ? ["unreviewed long-lived state:", ...extra.map(show)] : []),
      ...(stale.length ? ["reviewed rows that match no line any more:", ...stale.map(show)] : []),
      ...(badScope.length ? ["rows without a valid scope:", ...badScope.map(show)] : []),
      "Read each one: its key must be scoped by user, space, bot, thread or run (or hold only",
      "constant, public or per-IP/token data). Add a row to dozo/db/module-state-reviewed.tsv",
      "(file, where, line, scope, note), or run this with --write and fill in the TODO rows.",
    ].join("\n"),
  );
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
