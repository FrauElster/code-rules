import { LANG_FLAG } from '../lib/args.ts';
import type { Command, Options } from '../lib/types.ts';

type Lang = 'ts' | 'go';

interface Rule {
    langs: readonly Lang[];
    text: string;
}

const BOTH: readonly Lang[] = ['ts', 'go'];

// general rules from lumaric-erp's root AGENTS.md "Code rules"; the rest are what this tool's checks look for
const RULES: Rule[] = [
    {
        langs: BOTH,
        text: '**Comments** — only for unexpected/non-obvious behaviour (platform quirks, deliberate-looking-wrong guards, layout hacks). Terse lowercase fragments, no trailing period, ~1 line. Never restate the next line, never describe the change process, tasks or plans. No `// ---` / `// ===` rulers. Applies to doc comments too.',
    },
    {
        langs: BOTH,
        text: '**Inline single-caller code** — a simple helper or top-level `const` used from exactly one function becomes a local in that function, unless it is exported, tested on its own, or names a meaningful step.',
    },
    {
        langs: BOTH,
        text: '**Docs** — update the matching doc in the same commit as the code. Docs describe the current code only — no history, no "now/previously", no changelogs; state the reasoning only when a design would look wrong without it. Delete what is no longer true.',
    },
    {
        langs: BOTH,
        text: '**Subagents** — avoid for work you can do directly; use them only for real parallelism or separation of concerns.',
    },
    {
        langs: BOTH,
        text: '**One assignment per statement** — never assign several independent values at once (`x, y := 1, 2`, `let a = 1, b = 2`, `const [a, b] = [1, 2]`); give each its own line. Destructuring a call that returns several values (`v, err := f()`, `const [a, b] = f()`), a swap (`a, b = b, a`) and a `for` clause are fine.',
    },
    {
        langs: ['ts'],
        text: '**No linter suppressions** — never `// @ts-ignore`, `// @ts-expect-error`, and no `// biome-ignore` to hide a problem; fix the root cause. The one exception is performance: when a biome rule blocks a change that is better for speed, memory or CPU, skip it with `// biome-ignore lint/<group>/<rule>: <the gain>` (one line naming what it buys). Measure first; a rule is never skipped for convenience.',
    },
    {
        langs: ['ts'],
        text: '**Casts** — avoid `as unknown as`; restructure so a direct cast or none is needed. A bridge through `unknown` is acceptable only for a small, structurally related type when a direct expression causes a TypeScript performance problem, never to hide an incompatible shape.',
    },
    {
        langs: ['ts'],
        text: "**Type lookups** — write a type's own name instead of an indexed access (`Engine`, not `Car['engine']`), unless the point is to track the other type.",
    },
    {
        langs: ['ts'],
        text: "**No barrel imports** — import the single module, not a named import from a barrel (`import XMarkIcon from '@heroicons/react/24/outline/XMarkIcon'`): tsc resolves every module a barrel re-exports.",
    },
    {
        langs: BOTH,
        text: '**Names** — a variable, parameter or catch binding says what the value is, never a single letter; `_` for an ignored binding and short Go method receivers are the exceptions.',
    },
    {
        langs: ['ts'],
        text: "**Formatting** — only through the project's `lint:fix` script, which passes the right `--config-path`. Never run `biome format` / `biome check` directly: without the config it rewrites every file it touches with the default style, and biome keeps objects and calls it has expanded expanded, so a later run with the right config does not undo it.",
    },
    {
        langs: ['ts'],
        text: "**Lint clean** — the project's `pnpm lint` passes before a change is done; fix what it reports, don't suppress it.",
    },
    {
        langs: ['go'],
        text: '**`go fix` clean** — `go fix -diff ./...` reports no patch before a change is done; apply its modernizations with `go fix ./...`.',
    },
    {
        langs: ['go'],
        text: '**No linter suppressions** — never `//nolint` to hide a problem; fix the root cause. The one exception is performance: `//nolint:<linter> // <the gain>` (one line naming what it buys). Measure first; a rule is never skipped for convenience.',
    },
    {
        langs: ['go'],
        text: '**No long declarations in `if`** — an init statement stays short and on one line (`if err := f(); err != nil` is fine). When the declaration is long or spans several lines, declare it on the line before and keep the `if` to its condition.',
    },
];

const rules: Command = {
    name: 'rules',
    summary: "print the code style rules as Markdown, for an agent's AGENTS.md",
    flags: [LANG_FLAG],
    help: `
Prints the style rules these checks enforce as a Markdown section, ready to paste
into a project's AGENTS.md. Takes no path, or one to auto-detect --lang from;
with neither, prints the general rules plus the TypeScript and Go sections.`,

    run(options: Options) {
        const lang = options.lang as Lang | undefined;
        const bullets = (selected: Rule[]) => selected.map(rule => `- ${rule.text}`);
        const lines = ['## Code rules', ''];
        if (lang) lines.push(...bullets(RULES.filter(rule => rule.langs.includes(lang))));
        else {
            lines.push(...bullets(RULES.filter(rule => rule.langs.length === BOTH.length)));
            lines.push('', '### TypeScript', '', ...bullets(RULES.filter(rule => rule.langs.length === 1 && rule.langs[0] === 'ts')));
            lines.push('', '### Go', '', ...bullets(RULES.filter(rule => rule.langs.length === 1 && rule.langs[0] === 'go')));
        }
        lines.push('', `Run \`node ${process.argv[1]} all <path>\` after a change to list candidates for these rules.`);
        console.log(lines.join('\n'));
    },
};

export default rules;
