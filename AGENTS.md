# AGENTS.md — code-rules

## What this is

`code-rules` is a local-only CLI (not published, not part of any other repo)
that scans a TypeScript (or Go) project graph and flags candidates for a set
of style rules — originally lumaric-erp's own `AGENTS.md` conventions. It
reports candidates, never verdicts: every hit still needs a human judgment
call. See `README.md` for the full command reference; this file covers how
the tool is built and the style it holds itself to.

## How it works, at a high level

- `cli.ts` is the entry point. It registers twelve checks (`inline`,
  `comments`, `stale-comments`, `casts`, `type-lookup`, `explicit-import`, `single-letter`,
  `if-init`, `multi-assign`, `dead-code`, `lint`, `vuln`) plus a synthetic `all` command that runs every check with a
  side for the chosen `--lang` over one shared project graph, and two `run`
  commands that build no graph and get the paths as given: `docs` (changelog
  wording in Markdown) and `rules`, which needs no path and prints the style
  rules (`commands/rules.ts`) as Markdown for another project's `AGENTS.md`.
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
- `lib/git.ts` shells out to `git status`/`git diff` for the hunks changed
  since `HEAD` (`--scope=uncommitted`) or a revision (`--scope=<rev>`, checked
  with `git rev-parse` before any check runs). `addedLines` backs the line
  filters; `stale-comments` reads the hunks themselves, with their removed text.
- Seven commands (`inline`, `comments`, `stale-comments`, `single-letter`, `if-init`, `multi-assign`, `dead-code`) support `--lang=go`, bypassing
  ts-morph entirely: `lib/go-project.ts` walks a directory for `.go` files (`lib/files.ts`, shared with `docs`),
  `lib/go-comments.ts` is a hand-rolled comment lexer, and
  `lib/go-analyzer.ts` shells out to `go run go-analyzer/main.go <mode>` (a
  stdlib-only `go/ast` program) for reference counting (`inline`), `if`
  init statements (`if-init`, Go only), multi-value assignments
  (`multi-assign`) and bound names (`single-letter`). `lint` and `vuln` are the odd ones out: `createTool` factories that
  get only the resolved tsconfigs / `.go` files and shell out to the
  project's own `pnpm lint` / Go lint (`gofmt -l`, a Taskfile's `lint:go`/`lint`, else `go vet` + `go fix -diff`) or to `pnpm audit` /
  `govulncheck ./...` (shared spawn/report code lives in `lib/tool.ts`) — `cli.ts` skips
  building the ts-morph graph when it's the only check running. Go support is
  identifier-name matching, not symbol resolution — treat its output as a
  rougher candidate list than the ts-morph side.

Current capabilities (see `README.md` for flags and examples):

| Command | What it flags |
|---|---|
| `inline` | top-level functions/consts with exactly one caller |
| `comments` | comments over 3 lines or prose-like (`/* */` or adjacent `//` runs), comments mentioning a `*.md` file, changelog wording |
| `stale-comments` | comments the diff left unchanged beside code it changed |
| `casts` | redundant `as`/`<T>` assertions, `as any`, `as unknown as` |
| `type-lookup` | `Car["engine"]` where the result has a name of its own |
| `explicit-import` | named imports from barrel modules, with `--fix` |
| `single-letter` | variables/parameters/catch bindings named with a single letter |
| `if-init` | Go `if` statements with a multi-line init statement, or a long one declaring more than `err` |
| `multi-assign` | several values assigned in one statement, minus swaps and `for` clauses |
| `dead-code` | top-level bindings with no production reference — unused, or only used in tests |
| `lint` | a failing `pnpm lint` (TS), or for Go unformatted files (`gofmt -l`) and a failing lint task or `go vet` / `go fix -diff ./...` |
| `vuln` | a failing `pnpm audit` (TS) or `govulncheck ./...` (Go) — known vulnerable dependencies |
| `docs` | changelog wording in Markdown docs (not in `all`) |

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
- A new check gets a matching rule in `commands/rules.ts`, so `rules`
  keeps describing exactly what the checks look for.
- Keep `README.md` in sync with `cli.ts`/`commands/*.ts` when flags, output
  formats, or command behavior change — it's the source of truth for usage.
