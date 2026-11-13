#!/usr/bin/env node
// local-only style-rule checks for lumaric-erp's AGENTS.md — see README.md
// usage: node cli.ts <command> <tsconfig.json|dir> [...] [flags]   (`--help` anywhere)

import casts from './commands/casts.ts';
import comments from './commands/comments.ts';
import explicitImport from './commands/explicit-import.ts';
import ifInit from './commands/if-init.ts';
import inline from './commands/inline.ts';
import multiAssign from './commands/multi-assign.ts';
import rules from './commands/rules.ts';
import singleLetter from './commands/single-letter.ts';
import typeLookup from './commands/type-lookup.ts';
import { helpText, parseFlags } from './lib/args.ts';
import { detectLang } from './lib/detect-lang.ts';
import { resolveGoFiles } from './lib/go-project.ts';
import { eachProject, resolveTsConfigs } from './lib/project.ts';
import type { Command, FlagSpec } from './lib/types.ts';

const COMMANDS: Command[] = [inline, comments, casts, typeLookup, explicitImport, singleLetter, ifInit, multiAssign];

// two commands may share a flag only by sharing the one spec object (SCOPE_FLAG) — same name, two specs would
// silently give `all` one command's parsing for both
function sharedFlags(): FlagSpec[] {
    const flags = [...new Set(COMMANDS.flatMap(c => c.flags))];
    const byName = new Map<string, FlagSpec>();
    for (const f of flags) {
        const name = f.flag.split('=')[0]!;
        if (byName.has(name)) throw new Error(`duplicate flag ${name} across commands`);
        byName.set(name, f);
    }
    return flags;
}

const ALL: Command = {
    name: 'all',
    summary: 'run every check over one shared project graph',
    flags: sharedFlags(),
    help: `
Runs ${COMMANDS.map(c => c.name).join(', ')} against a single ts-morph Project per
tsconfig. Building that graph is the ~1-2 min cost, so this is much faster than
separate invocations — and it's what AGENTS.local.md's plan rule calls. With
--lang=go it runs only the checks that have a Go side.

Takes the union of the subcommands' flags; each one means what it means there.`,
    members: COMMANDS,
};

function usage(): string {
    const commands = [...COMMANDS, ALL, rules];
    const width = Math.max(...commands.map(c => c.name.length));
    return [
        'code-rules — local-only checks for lumaric-erp AGENTS.md style rules',
        '',
        'usage: node cli.ts <command> <tsconfig.json|dir> [...] [flags]',
        '',
        'commands:',
        ...commands.map(c => `  ${c.name.padEnd(width)}  ${c.summary}`),
        '',
        'A path is a project tsconfig (backend/tsconfig.json, ui/tsconfig.app.json,',
        'plugins/tsconfig.backend.json, plugins/tsconfig.ui.json, cli/tsconfig.json) or a',
        'directory, walked for project tsconfigs — solution-style ones are skipped.',
        '',
        "node cli.ts <command> --help  for that command's flags.",
    ].join('\n');
}

function run(): void {
    const argv = process.argv.slice(2);
    const commandName = argv[0];
    const command = [...COMMANDS, ALL, rules].find(c => c.name === commandName);
    if (!command) {
        console.log(usage());
        process.exit(commandName === undefined || commandName === '--help' || commandName === '-h' ? 0 : 1);
    }
    const rest = argv.slice(1);
    if (rest.includes('--help') || rest.includes('-h')) {
        console.log(helpText(command));
        process.exit(0);
    }

    let paths: string[];
    let options: ReturnType<typeof parseFlags>['options'];
    try {
        ({ paths, options } = parseFlags(rest, command.flags));
    } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
    }
    if (command.run) {
        if (options.lang === undefined && paths.length > 0) options.lang = detectLang(paths);
        command.run(options);
        return;
    }
    if (paths.length === 0) {
        console.error(`${command.name}: no tsconfig/directory given\n\n${helpText(command)}`);
        process.exit(1);
    }

    if (options.lang === undefined) options.lang = detectLang(paths);

    const isGo = options.lang === 'go';
    const members = (command.members ?? [command]).filter(c => (isGo ? c.createGo : c.create));
    if (members.length === 0) {
        console.error(`${command.name}: --lang=${options.lang} is not supported by this command`);
        process.exit(1);
    }

    // Go has no tsconfig/type graph, so it bypasses ts-morph/eachProject entirely — a command that
    // supports it exposes a createGo() factory taking a file path instead of a ts-morph sourceFile
    let runs: { name: string; run: { report(): void } }[];
    if (isGo) {
        let goFiles: string[];
        try {
            goFiles = resolveGoFiles(paths);
        } catch (e) {
            console.error((e as Error).message);
            process.exit(1);
        }
        const goRuns = members.map(c => ({ name: c.name, run: c.createGo!(options) }));
        for (const r of goRuns) r.run.visit(goFiles);
        runs = goRuns;
    } else {
        let tsConfigFilePaths: string[];
        try {
            tsConfigFilePaths = resolveTsConfigs(paths);
        } catch (e) {
            console.error((e as Error).message);
            process.exit(1);
        }
        const tsRuns = members.map(c => ({ name: c.name, run: c.create!(options) }));
        for (const ctx of eachProject(tsConfigFilePaths)) {
            for (const r of tsRuns) r.run.visit(ctx);
        }
        runs = tsRuns;
    }

    for (const [i, r] of runs.entries()) {
        if (runs.length > 1) console.log(`${i > 0 ? '\n' : ''}== ${r.name} ==\n`);
        r.run.report();
    }
}

run();
