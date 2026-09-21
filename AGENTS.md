# AGENTS.md — code-rules

## What this is

`code-rules` is a local-only CLI (not published, not part of any other repo)
that scans a TypeScript (or Go) project graph and flags candidates for a set
of style rules — originally lumaric-erp's own `AGENTS.md` conventions. It
reports candidates, never verdicts: every hit still needs a human judgment
call. See `README.md` for the full command reference; this file covers how
the tool is built and the style it holds itself to.

## How it works, at a high level

- `cli.ts` is the entry point. It registers six checks (`inline`,
  `comments`, `casts`, `type-lookup`, `explicit-import`, `single-letter`)
  plus a synthetic `all` command that runs all six over one shared project
  graph.
- Each command lives in `commands/*.ts` and exports a `Command` (see
  `lib/types.ts`): a name, flag specs, help text, and a `create(options)`
  factory returning `{ visit, report }`. `visit` is called once per
  ts-morph project (tsconfig); `report` prints results at the end.
- `lib/project.ts` resolves tsconfig paths to a `ts-morph` `Project` per
  tsconfig and yields `{ tsConfigFilePath, project, sourceFiles }`. One
  `Project` per tsconfig, never merged — workspaces consume each other's
  built `.d.ts`, not source, so a symbol's references never cross tsconfigs.
- `lib/args.ts` is a tiny flag parser shared by every command; `SCOPE_FLAG`
  and `LANG_FLAG` are shared spec objects so `all` doesn't see two commands
  claim the same flag name with different definitions.
- `lib/git.ts` shells out to `git status`/`git diff` to compute which lines
  changed since `HEAD`, backing every command's `--scope=uncommitted`.
- Two commands (`inline`, `comments`) also support `--lang=go`, bypassing
  ts-morph entirely: `lib/go-project.ts` walks a directory for `.go` files,
  `lib/go-comments.ts` is a hand-rolled comment lexer, and
  `lib/go-analyzer.ts` shells out to `go run go-analyzer/main.go` (a
  stdlib-only `go/ast` program) for reference counting. Go support is
  identifier-name matching, not symbol resolution — treat its output as a
  rougher candidate list than the ts-morph side.

Current capabilities (see `README.md` for flags and examples):

| Command | What it flags |
|---|---|
| `inline` | top-level functions/consts with exactly one caller |
| `comments` | multi-line comments (`/* */` or adjacent `//` runs) |
| `casts` | redundant `as`/`<T>` assertions, `as any`, `as unknown as` |
| `type-lookup` | `Car["engine"]` where the result has a name of its own |
| `explicit-import` | named imports from barrel modules, with `--fix` |
| `single-letter` | variables/parameters/catch bindings named with a single letter |

## Setup

    pnpm install
    pnpm lint       # tsc (type-check only) + biome check
    pnpm lint:fix   # biome --fix --unsafe, then tsc

Node runs the `.ts` files directly (native TypeScript support, no build
step) — always invoke `node cli.ts ...`, never compile to `.js` first.

## Code style

- TypeScript, strict (see `tsconfig.json`: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noUnusedLocals`/`Parameters`, etc.) —
  `pnpm lint` must pass clean before considering a change done.
- Formatting and linting are Biome's job (`biome.json`), not manual style
  debates. Run `pnpm lint:fix` rather than hand-formatting.
- Prefer a real ts-morph type + a `Node.isX(...)` type guard over a raw
  `SyntaxKind` comparison plus an `as unknown as { ... }` cast. This
  codebase's own `casts` command exists to catch exactly that pattern —
  dogfood it (`node cli.ts casts tsconfig.json`) before committing.
- A cast that only strips `undefined` after a runtime check the type
  checker can't see (e.g. `map.get(k)` right after `map.has(k)`) should be
  a non-null assertion (`x!`), not `x as T` — the assertion says "this is
  never undefined here", the cast claims a type change that isn't happening.
- `noExplicitAny` is off deliberately: ts-morph's own API sometimes forces
  an escape hatch (see the `unknown-chain`/duck-typed casts this tool used
  to have before cleanup). Reach for it only when a real ts-morph/compiler
  type genuinely doesn't exist for what you need — check first.
- Comments: state the non-obvious *why*, not the *what*. A comment
  explaining a subtle invariant, a deliberate scope decision, or a shared
  flag-spec gotcha is worth keeping; a comment restating what the next line
  already says is not. No JSDoc blocks on internal functions — this is a
  private CLI, not a published API.
- No abstractions beyond what a command needs. Each check in `commands/`
  is self-contained; shared logic only moves to `lib/` when two or more
  commands actually need it (see `SCOPE_FLAG`/`LANG_FLAG`, `addedLines`).
- Keep `README.md` in sync with `cli.ts`/`commands/*.ts` when flags, output
  formats, or command behavior change — it's the source of truth for usage.
