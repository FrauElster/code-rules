# code-rules

Static-analysis CLI that flags inlinable functions/consts, long or prose-like comments, comments left unchanged beside changed code, changelog wording in comments and Markdown docs, redundant type casts, indexed-access types with a real name, barrel imports, single-letter identifiers, dead code (unused, or used only by tests), long Go `if` init statements, several values assigned in one statement, failing `pnpm lint` / Go lint (`gofmt -l`, the project's lint task or `go vet` + `go fix -diff`) runs, and known-vulnerable dependencies (`pnpm audit` / `govulncheck`) in TypeScript (and partially Go) codebases — and prints the matching style rules for an agent's `AGENTS.md`.

## Requirements

- Node.js 22+ (native TypeScript support, no build step)
- pnpm 12+ (also what `lint` runs for TypeScript projects)
- Go toolchain on `PATH` (only for `--lang=go` checks)

## Install

    pnpm install

## Usage

    node cli.ts <command> <tsconfig.json|dir> [...] [flags]

| Command | Checks |
|---|---|
| `inline` | top-level functions/consts used from exactly one place |
| `comments` | comments longer than `--max-comment-lines` (default 3), prose-like ones (trailing `.`/`!`/`?`/`;`, or a sentence break in a one-line comment), ones mentioning a `*.md` file (plan/knowledge references), and changelog wording (`previously`, `used to be`, `was changed/replaced/removed/renamed`, `phase N`) |
| `stale-comments` | a comment the diff left unchanged while the code it sits on changed: the statement or declaration below an own-line comment (at most 10 lines; section headers and Go `const (` groups skipped), or the code before a trailing one. Needs a diff scope |
| `casts` | type assertions the type already satisfies, `as any`, `as unknown as` |
| `type-lookup` | `Car["engine"]` where the property's type has a name of its own |
| `explicit-import` | named imports from barrel modules (`--fix`) |
| `single-letter` | variables/parameters/catch bindings named with a single letter (Go: `:=`/`var`/`range` bindings, params and named results; receivers, stdlib idioms like `w http.ResponseWriter`/`r *http.Request`/`t *testing.T`, `i`/`j`/`k` loop counters and `a, b` comparators exempt; `--allow-typed=name:type` adds more) |
| `if-init` | Go only: `if` init statements spanning several lines, or longer than `--max-length` (default 40) and declaring more than `err` |
| `multi-assign` | several values assigned in one statement (`x, y := 1, 2`, `let a = 1, b = 2`, `[a, b] = [1, 2]`, Go `var (...)` groups inside a func), except swaps, `for` clauses and iota `const` blocks |
| `dead-code` | top-level functions, consts, classes, types and enums nothing references (`unused`), or only tests do (`only used in tests — evaluate if this should stay`); exported bindings need `--include-exported`. TS loads `*.test.*`/`*.spec.*`/`__tests__` files into the graph even when the tsconfig excludes them; Go treats `*_test.go` as tests and resolves cross-package uses through `go.mod` |
| `lint` | runs `pnpm lint` (nearest `package.json` with a `lint` script above each tsconfig), or for Go in the nearest `go.mod` directory `gofmt -l .` plus the Taskfile's `lint:go`/`lint` task (with `task` on PATH, once per Taskfile), else `go vet ./...` and `go fix -diff ./...`; reports failures with their output; always the whole project, never rewrites files |
| `vuln` | runs `pnpm audit` (nearest `pnpm-lock.yaml` above each tsconfig) or `govulncheck ./...` (nearest `go.mod`) and reports failures with their output; needs network, and `govulncheck` on PATH for Go (`go install golang.org/x/vuln/cmd/govulncheck@latest`) |
| `all` | every check above, over one shared project graph (with `--lang=go`, the checks that have a Go side: `inline`, `comments`, `stale-comments`, `single-letter`, `if-init`, `multi-assign`, `dead-code`, `lint`, `vuln`) |
| `docs` | changelog wording in the given Markdown files or every `*.md` under the given directories (the `comments` words plus `no longer`), outside fenced code blocks; not part of `all`, docs often live outside the code paths |
| `rules` | print the style rules as Markdown (no path needed) |

    node cli.ts all ./tsconfig.json
    node cli.ts explicit-import ./tsconfig.json --fix
    node cli.ts all ./backend --scope=main      # review a branch: lines changed since main, working tree included
    node cli.ts docs ./knowledge --scope=all

`--scope` narrows the line-based checks: `uncommitted` (default) is lines added or modified since `HEAD`, `all` is everything, and any other value is a git revision — lines changed since it, so a reviewed commit range plus the working tree. A path outside a git repository has no changed lines.

`--lang` auto-detects from the path (`go.mod` → go, else ts) unless passed explicitly. `node cli.ts --help` lists commands; `node cli.ts <command> --help` gives that command's flags.

## Rules for agents

`rules` prints the style rules these checks enforce — the general code rules from lumaric-erp's `AGENTS.md` plus one per check — as a `## Code rules` Markdown section to paste into a project's `AGENTS.md`:

    node cli.ts rules               # general + TypeScript + Go sections
    node cli.ts rules --lang=go     # general + Go only, as one flat list
    node cli.ts rules ./some/repo   # --lang auto-detected from the path

The output ends with the `node <path>/cli.ts all <path>` command to run afterward to catch violations the agent missed.
