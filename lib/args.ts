import type { Command, FlagSpec, Options } from './types.ts';

// shared by every check that can narrow itself to changed lines — one spec object so `all` gives the
// subcommands the same value instead of two conflicting --scope defaults
export const SCOPE_FLAG: FlagSpec = {
    flag: '--scope=uncommitted|all|<rev>',
    key: 'scope',
    kind: 'string',
    default: 'uncommitted',
    desc: 'which lines to check: those added/modified since HEAD, everything, or those changed since a git revision (a commit range under review, plus the working tree)',
};

// shared by every check with a Go-side implementation — one spec object so `all` doesn't see two
// conflicting --lang specs (see lib/args.ts's sharedFlags duplicate-name check in cli.ts)
export const LANG_FLAG: FlagSpec = {
    flag: '--lang=ts|go',
    key: 'lang',
    kind: 'enum',
    values: ['ts', 'go'],
    desc: 'which project graph to scan: TypeScript (ts-morph, needs a tsconfig/dir) or Go (needs a dir/*.go, no type graph). Default: auto-detected from the path (go.mod → go, else ts)',
};

// shared by `inline` and `dead-code` — one spec object for the same reason as SCOPE_FLAG
export const INCLUDE_EXPORTED_FLAG: FlagSpec = {
    flag: '--include-exported',
    key: 'includeExported',
    kind: 'boolean',
    default: false,
    desc: 'also flag exported bindings (callers outside the scanned paths are invisible)',
};

// a flag spec is { flag, key, kind: 'boolean'|'number'|'string'|'enum'|'list', values?, default?, desc }
// `flag` is the display form ('--max-lines=N'), everything before the '=' is the matched name

function flagName(spec: FlagSpec): string {
    return spec.flag.split('=')[0]!;
}

export function parseFlags(argv: string[], specs: FlagSpec[]): { paths: string[]; options: Options } {
    const byName = new Map(specs.map(s => [flagName(s), s]));
    const options: Options = {};
    for (const s of specs) options[s.key] = s.kind === 'list' ? [...((s.default as string[] | undefined) ?? [])] : s.default;

    const paths: string[] = [];
    for (const arg of argv) {
        if (!arg.startsWith('--')) {
            paths.push(arg);
            continue;
        }
        const eq = arg.indexOf('=');
        const name = eq === -1 ? arg : arg.slice(0, eq);
        const raw = eq === -1 ? null : arg.slice(eq + 1);
        const spec = byName.get(name);
        if (!spec) throw new Error(`unknown flag: ${arg}\nvalid flags: ${specs.map(s => s.flag).join(' ')}`);
        if (spec.kind === 'boolean') {
            if (raw !== null) throw new Error(`${name} takes no value`);
            options[spec.key] = true;
        } else {
            if (raw === null || raw === '') throw new Error(`${spec.flag} needs a value`);
            if (spec.kind === 'number') {
                const n = Number(raw);
                if (!Number.isFinite(n)) throw new Error(`${name} needs a number, got '${raw}'`);
                options[spec.key] = n;
            } else if (spec.kind === 'enum') {
                if (!spec.values?.includes(raw)) throw new Error(`${name} must be one of ${spec.values?.join('|')}, got '${raw}'`);
                options[spec.key] = raw;
            } else if (spec.kind === 'string') {
                options[spec.key] = raw;
            } else {
                (options[spec.key] as string[]).push(raw);
            }
        }
    }
    return { paths, options };
}

export function helpText(command: Command): string {
    const lines = [`${command.name} — ${command.summary}`, '', `usage: node cli.ts ${command.name} <tsconfig.json|dir> [...] ${command.flags.map(f => `[${f.flag}]`).join(' ')}`];
    if (command.flags.length > 0) {
        lines.push('', 'flags:');
        const width = Math.max(...command.flags.map(f => f.flag.length));
        for (const f of command.flags) {
            const dflt = f.kind === 'boolean' || f.default === undefined || (Array.isArray(f.default) && f.default.length === 0) ? '' : ` (default ${f.default})`;
            lines.push(`  ${f.flag.padEnd(width)}  ${f.desc}${dflt}`);
        }
    }
    if (command.help) lines.push('', command.help.trim());
    return lines.join('\n');
}
