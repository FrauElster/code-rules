# code-rules

Static-analysis CLI that flags inlinable functions/consts, multi-line comments, redundant type casts, indexed-access types with a real name, barrel imports, and single-letter identifiers in TypeScript (and partially Go) codebases.

## Requirements

- Node.js 22+ (native TypeScript support, no build step)
- pnpm 12+
- Go toolchain on `PATH` (only for `--lang=go` checks)

## Install

    pnpm install

## Usage

    node cli.ts <command> <tsconfig.json|dir> [...] [flags]

| Command | Checks |
|---|---|
| `inline` | top-level functions/consts used from exactly one place |
| `comments` | multi-line comments (hard cap ~1 line rule) |
| `casts` | type assertions the type already satisfies, `as any`, `as unknown as` |
| `type-lookup` | `Car["engine"]` where the property's type has a name of its own |
| `explicit-import` | named imports from barrel modules (`--fix`) |
| `single-letter` | variables/parameters/catch bindings named with a single letter |
| `all` | every check, over one shared project graph |

    node cli.ts all ./tsconfig.json
    node cli.ts explicit-import ./tsconfig.json --fix

`node cli.ts --help` lists commands; `node cli.ts <command> --help` gives that command's flags.

## Recommended prompt

Paste this into an agent's project instructions to enforce the same comment/style rules this tool checks for:

    - No `as unknown as` — restructure types so a single `as` or no cast is needed.
    - No linter suppressions — never add `// eslint-disable`, `// biome-ignore`, `// @ts-ignore`, or `// @ts-expect-error`. Fix the root cause.
    - No comment-ruler lines — no `// ---` or `// ===` separator comments. Organise code with blank lines and clear naming.
    - Comments only for unexpected/non-obvious behaviour — never restate what the next line already says. Terse fragments or bullets, never full sentences: lowercase, no trailing period, hard cap ~1 line. Keep: platform quirks, deliberate-looking-wrong guards, workarounds, suppression justifications. Applies to JSDoc too — compress to a fragment documenting only the surprising part.
    - Comments describe the code, never the process that produced it — no references to tasks, stages, progress, plans, or TODO files.
    - Inline single-caller, simple helper functions — a small function called from exactly one place becomes a local `const` in that caller instead of a separate top-level function, unless it's independently meaningful.
    - Inline single-caller top-level consts — a top-level `const` only ever used inside one function becomes a local `const` in that function, unless it's independently meaningful.

Run `node cli.ts all <tsconfig>` afterward to catch violations the agent missed.
