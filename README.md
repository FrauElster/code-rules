# code-rules

Static-analysis CLI that flags inlinable functions/consts, multi-line or prose-like comments, redundant type casts, indexed-access types with a real name, barrel imports, single-letter identifiers, dead code (unused, or used only by tests), long Go `if` init statements, several values assigned in one statement, failing `pnpm lint` / `go fix -diff` runs, and known-vulnerable dependencies (`pnpm audit` / `govulncheck`) in TypeScript (and partially Go) codebases — and prints the matching style rules for an agent's `AGENTS.md`.

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
| `comments` | multi-line comments, and prose-like ones (trailing `.`/`!`/`?`/`;`, or a mid-comment sentence break), and ones mentioning a `*.md` file (plan/knowledge references) |
| `casts` | type assertions the type already satisfies, `as any`, `as unknown as` |
| `type-lookup` | `Car["engine"]` where the property's type has a name of its own |
| `explicit-import` | named imports from barrel modules (`--fix`) |
| `single-letter` | variables/parameters/catch bindings named with a single letter (Go: `:=`/`var`/`range` bindings, params and named results; receivers, stdlib idioms like `w http.ResponseWriter`/`r *http.Request`/`t *testing.T`, `i`/`j`/`k` loop counters and `a, b` comparators exempt; `--allow-typed=name:type` adds more) |
| `if-init` | Go only: `if` init statements longer than `--max-length` (default 40) or spanning several lines |
| `multi-assign` | several values assigned in one statement (`x, y := 1, 2`, `let a = 1, b = 2`, `[a, b] = [1, 2]`, Go `var (...)` groups inside a func), except swaps, `for` clauses and iota `const` blocks |
| `dead-code` | top-level functions, consts, classes, types and enums nothing references (`unused`), or only tests do (`only used in tests — evaluate if this should stay`); exported bindings need `--include-exported`. TS loads `*.test.*`/`*.spec.*`/`__tests__` files into the graph even when the tsconfig excludes them; Go treats `*_test.go` as tests and resolves cross-package uses through `go.mod` |
| `lint` | runs `pnpm lint` (nearest `package.json` with a `lint` script above each tsconfig) or `go fix -diff ./...` (nearest `go.mod`) and reports failures with their output; always the whole project, never rewrites files |
| `vuln` | runs `pnpm audit` (nearest `pnpm-lock.yaml` above each tsconfig) or `govulncheck ./...` (nearest `go.mod`) and reports failures with their output; needs network, and `govulncheck` on PATH for Go (`go install golang.org/x/vuln/cmd/govulncheck@latest`) |
| `all` | every check, over one shared project graph (with `--lang=go`, the checks that have a Go side: `inline`, `comments`, `single-letter`, `if-init`, `multi-assign`, `dead-code`, `lint`, `vuln`) |
| `rules` | print the style rules as Markdown (no path needed) |

    node cli.ts all ./tsconfig.json
    node cli.ts explicit-import ./tsconfig.json --fix

`--lang` auto-detects from the path (`go.mod` → go, else ts) unless passed explicitly. `node cli.ts --help` lists commands; `node cli.ts <command> --help` gives that command's flags.

## Rules for agents

`rules` prints the style rules these checks enforce — the general code rules from lumaric-erp's `AGENTS.md` plus one per check — as a `## Code rules` Markdown section to paste into a project's `AGENTS.md`:

    node cli.ts rules               # general + TypeScript + Go sections
    node cli.ts rules --lang=go     # general + Go only, as one flat list
    node cli.ts rules ./some/repo   # --lang auto-detected from the path

The output ends with the `node <path>/cli.ts all <path>` command to run afterward to catch violations the agent missed.
