# code-rules

Local-only tool (not part of any repo) that checks lumaric-erp's `AGENTS.md`
style rules over a TypeScript project graph. Formerly `find-inline-helpers`.

## Usage

    node cli.js <command> <tsconfig.json|dir> [...] [flags]

| Command | Checks |
|---|---|
| `inline` | top-level functions/consts used from exactly one place |
| `comments` | multi-line comments (hard cap ~1 line rule) |
| `casts` | type assertions the type already satisfies, `as any`, `as unknown as` |
| `type-lookup` | `Car["engine"]` where the property's type has a name of its own |
| `explicit-import` | named imports from barrel modules (`--fix`) |
| `all` | every check, over one shared project graph |

`node cli.js --help` lists the commands; `node cli.js <command> --help` gives
that command's flags and the rule it enforces.

Each path argument is either a *project* tsconfig (an `include`/`files` list and
real compiler options) or a directory, walked recursively for `tsconfig*.json`.
A directory scan skips solution-style tsconfigs (bare `references`) and
`node_modules`/`.types`/`dist`/`.git`. In lumaric-erp the project tsconfigs are
`backend/tsconfig.json`, `ui/tsconfig.app.json`, `plugins/tsconfig.backend.json`,
`plugins/tsconfig.ui.json`, `cli/tsconfig.json` — not the bare
`plugins/tsconfig.json`, which is solution-style and skipped automatically.

    node cli.js all ~/programming/lumaric/lumaric-erp/plugins/tsconfig.backend.json
    node cli.js explicit-import ~/programming/lumaric/lumaric-erp/plugins/tsconfig.ui.json --fix

Prefer `all` over separate invocations: building the ts-morph project is the
whole cost (~1-2 min for backend+plugins), and `all` builds it once.

## `inline`

    [--max-lines=5] [--include-exported]

Functions/const-arrows whose body fits `--max-lines` with exactly one reference
outside their declaration, and top-level consts whose references all sit inside
one enclosing function.

- Function caller count = reference count excluding the declaration itself, not
  just call-expressions — a function passed by reference still counts.
- Const candidates aren't limited to a single reference: they just have to share
  one enclosing function, since moving the const into that body is a straight
  inline however many times it's used there. A const referenced from two
  functions, or from module scope, is never flagged.
- `--max-lines` bounds functions only; consts have no size cutoff.
- Exported bindings are skipped by default (another package may import them with
  zero in-file references). `--include-exported` shows them, but a caller count
  of 1 there is not proof of safety — cross-workspace usages aren't visible.
- A top-level `const { a, b } = ...` destructuring is skipped entirely; only
  `const x = ...` with a plain identifier is considered.

## `comments`

    [--scope=uncommitted|all] [--lang=ts|go]

Every `/* */` block, or run of adjacent `//` lines, spanning more than one
physical line. `uncommitted` (the default) keeps it to comments overlapping a
line added/modified since `HEAD` — your own in-flight work. `--scope=all` audits
the whole project and makes no git calls.

- Shells out to `git status`/`git diff` per file, so each file must be in a git
  working tree; a file where that fails is silently skipped for this check.
- The diff is `git diff -U0 HEAD`, i.e. against the last commit — an amended or
  rebased `HEAD` won't match "uncommitted" the way `git diff <upstream>...HEAD`
  would.
- Comment detection uses the raw TypeScript scanner (no `reScanSlashToken`), so
  a regex literal containing `//` or `/*` can rarely misalign comment boundaries
  for the rest of that line.
- A `//` run only merges when there's no code between the lines: `code(); // note`
  followed by a `// comment` line is two comments, not one 2-line block.

### `--lang=go`

Only `comments` supports Go, and only that one flag — everything else (`inline`,
`casts`, `type-lookup`, `explicit-import`, `all`) is TypeScript/ts-morph only.

    node cli.js comments ~/programming/lumaric/lumaric-erp/go-service --lang=go

With `--lang=go` the path argument is a directory walked recursively for `*.go`
(or a single `.go` file) instead of a tsconfig — there's no type graph, so this
path skips ts-morph/`eachProject` entirely. `vendor/`, `node_modules/`, `.git/`
and any file carrying Go's standard generated-file marker
(`// Code generated ... DO NOT EDIT.`) are excluded.

Comment scanning for Go is a small hand-rolled lexer (`lib/go-comments.js`),
not a real Go parser — it only needs to track string/rune/raw-string
(`` ` ``) literals well enough not to mistake a `//` or `/*` inside one for a
real comment. The merge rule for adjacent `//` lines is the same as TS's.

## `casts`

    [--scope=uncommitted|all] [--cast-kind=<category>] [--include-literals]

`x as T` / `<T>x` assertions that don't tell the type system anything it didn't
already know, plus the two forms `AGENTS.md` bans outright:

| kind | meaning |
|---|---|
| `identical` | source and target print as the same type — pure noise |
| `widening` | source is already assignable to target (e.g. a literal type cast to its widened form) |
| `any` | `as any` |
| `unknown-chain` | `as unknown as T` — "restructure types so a single `as` or no cast is needed" |

- A cast that *narrows* or reinterprets (source not assignable to target) is the
  legitimate use and is never reported — `'x' as SupplierId` against a branded
  id, a union member pulled out of `string`, a downcast to a subtype.
- A cast whose source is `any`/`unknown` is never reported either: there the
  cast is what supplies the type. `as const` is skipped entirely.
- `--scope` is the same flag `comments` uses (one shared spec, so `all --scope=`
  moves both), and defaults to `uncommitted` for the same reason — a whole-repo
  pass is a codebase audit, not a check of your own in-flight work.
- Object/array literals are skipped unless `--include-literals`: inside an `as`
  they're contextually typed *by the assertion*, so they measure as assignable
  even when the cast is load-bearing (excess-property check, picking a union
  member). The flag exists for a deliberate sweep; expect false positives.
- `widening` hits are the judgment-call ones. `const s = 'draft' as string` is
  redundant only if nothing downstream wanted the literal type, and a cast that
  widens to a supertype on purpose (hiding extra fields) is a real technique.
- Two casts on one line produce two hits at the same `file:line`.

## `type-lookup`

    [--scope=uncommitted|all] [--lookup-kind=all|named|builtin] [--out-of-scope]

Indexed-access types whose result you could have written by name:

    type SteeringWheel = { brand: string };
    type Car = { steeringWheel: SteeringWheel };

    function x(s: Car['steeringWheel']) {}   // -> SteeringWheel

`named` resolves to a type alias / interface / class / enum, `builtin` to an
intrinsic (`Car['name']` → `string`).

- Only a *single unqualified name* is ever suggested. A generic instantiation is
  skipped, because the symbol name alone loses the type arguments — `Car['parts']`
  of type `Engine[]` carries the global `Array` symbol, not a usable suggestion.
  Unions and intersections (so every optional property, via `| undefined`),
  anonymous object types, and still-deferred `T['engine']` inside a generic are
  out for the same reason: no one name says it.
- The name has to mean the same thing *at that position* — it's resolved in the
  node's own scope and compared to the symbol, so a local type shadowing an
  imported one doesn't produce a bogus suggestion. Names that aren't in scope are
  skipped unless `--out-of-scope`, which prints the declaring file since acting on
  those means adding an import.
- A lookup sitting inside the declaration of the alias it resolves to
  (`type SearchPath = paths[keyof paths]`) is skipped — substituting there is
  circular.
- The judgment call is coupling: a lookup is deliberate when the point is to
  *track* the other type, so a signature keeps following `Car` if the property's
  type is swapped later.

## `explicit-import`

    [--barrel=<glob>] [--no-builtin-barrels] [--fix]

A named import from a barrel module makes tsc resolve every module the barrel
re-exports (300+ files per heroicons set) to use one of them.

    import { XMarkIcon } from '@heroicons/react/24/outline';        // barrel
    import XMarkIcon from '@heroicons/react/24/outline/XMarkIcon';  // one file

Built-in pattern: `@heroicons/react/*`. `--barrel=<glob>` adds more (repeatable,
`*` spans `/`); `--no-builtin-barrels` drops the built-ins.

Every rewrite is verified, never guessed: `<specifier>/<name>` must resolve
through the project's own module resolution — so tsconfig `paths` mappings like
`plugins/tsconfig.ui.json`'s heroicons entry are honoured — *and* the module it
resolves to must have a default export. A specifier failing either check is
reported as `skip` with the reason.

`--fix` rewrites a declaration only when every named specifier passes and the
declaration has no default/namespace import; emitted lines are sorted by module
specifier. Aliases (`{ X as Y }`), declaration-level `import type`, and
per-specifier `{ type X }` are all preserved. Anything else is left in place for
you to handle. Edits are applied to the file text directly, so re-run the
project's `pnpm lint:fix` afterwards if you want biome to re-sort the block.

## General notes

- One ts-morph `Project` per tsconfig — workspaces consume each other's built
  `.d.ts`, not source, so a symbol's references never span two tsconfigs.
- Running against a directory processes every project tsconfig found under it
  and concatenates results, so a symbol visible in two graphs shows up twice.
- Excluded from every check: `node_modules`, `.types`, `dist`, `schema`,
  `plugin-map.ts`, `.generated.`, `.test.`, `.spec.`, and every `.d.ts` — in
  lumaric-erp those are generated (`ui/src/api/types.d.ts`, `backend/schema/*`)
  or env shims, never hand-written style.
- Two commands may share a flag only by sharing one spec object (`SCOPE_FLAG`);
  `all` throws on startup if two specs claim the same flag name, since it parses
  one options object for every check.
- Slow-ish since ts-morph type-checks and builds a reference graph. Not a
  per-commit hook.
- Every check reports candidates, not verdicts — each still needs a judgment
  call (independently testable, genuinely naming something, deliberate JSDoc on
  an exported symbol).
