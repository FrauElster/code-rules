// shared by every check that can narrow itself to in-flight work — one spec object so `all` gives the
// subcommands the same value instead of two conflicting --scope defaults
export const SCOPE_FLAG = { flag: '--scope=uncommitted|all', key: 'scope', kind: 'enum', values: ['uncommitted', 'all'], default: 'uncommitted', desc: 'which lines to check: those added/modified since HEAD, or everything' };

// a flag spec is { flag, key, kind: 'boolean'|'number'|'enum'|'list', values?, default?, desc }
// `flag` is the display form ('--max-lines=N'); everything before the '=' is the matched name.

function flagName(spec) {
    return spec.flag.split('=')[0];
}

export function parseFlags(argv, specs) {
    const byName = new Map(specs.map(s => [flagName(s), s]));
    const options = {};
    for (const s of specs) options[s.key] = s.kind === 'list' ? [...(s.default ?? [])] : s.default;

    const paths = [];
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
                if (!spec.values.includes(raw)) throw new Error(`${name} must be one of ${spec.values.join('|')}, got '${raw}'`);
                options[spec.key] = raw;
            } else {
                options[spec.key].push(raw);
            }
        }
    }
    return { paths, options };
}

export function helpText(command) {
    const lines = [`${command.name} — ${command.summary}`, '', `usage: node cli.js ${command.name} <tsconfig.json|dir> [...] ${command.flags.map(f => `[${f.flag}]`).join(' ')}`];
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
