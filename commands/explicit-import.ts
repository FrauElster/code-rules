import { writeFileSync } from 'node:fs';
import { type Project, ts } from 'ts-morph';
import type { Command, Options } from '../lib/types.ts';

// packages whose subpath modules are barrels: a named import from one makes tsc resolve every module
// the barrel re-exports, not just the one used. Deep-importing the single module avoids that.
const BUILTIN_BARRELS = ['@heroicons/react/*'];

// `*` spans '/' — '@heroicons/react/*' is meant to cover '@heroicons/react/24/outline'
function globToRegExp(glob: string): RegExp {
    return new RegExp(
        `^${glob
            .split('*')
            .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*')}$`,
    );
}

function resolveDeep(deep: string, containingFile: string, project: Project, host: ts.ModuleResolutionHost): string | null {
    const { resolvedModule } = ts.resolveModuleName(deep, containingFile, project.getCompilerOptions(), host);
    return resolvedModule?.resolvedFileName ?? null;
}

function hasDefaultExport(project: Project, filePath: string, cache: Map<string, boolean>): boolean {
    if (cache.has(filePath)) return cache.get(filePath)!;
    const sf = project.addSourceFileAtPathIfExists(filePath);
    const has = sf !== undefined && sf.getDefaultExportSymbol() !== undefined;
    cache.set(filePath, has);
    return has;
}

interface Rewrite {
    deep: string;
    text: string;
}

interface Blocked {
    name: string;
    reason: string;
}

interface Hit {
    file: string;
    line: number;
    moduleSpecifier: string;
    count: number;
    rewrites: Rewrite[];
    blocked: Blocked[];
    fixable: boolean;
}

interface FileEdit {
    text: string;
    list: { start: number; end: number; replacement: string }[];
}

const explicitImport: Command = {
    name: 'explicit-import',
    summary: 'named imports from barrel modules (deep-import instead)',
    flags: [
        { flag: '--barrel=<glob>', key: 'barrels', kind: 'list', default: [], desc: 'additional barrel specifier pattern; repeatable, `*` spans /' },
        { flag: '--no-builtin-barrels', key: 'noBuiltins', kind: 'boolean', default: false, desc: 'drop the built-in patterns, use only --barrel' },
        { flag: '--fix', key: 'fix', kind: 'boolean', default: false, desc: 'rewrite fixable imports in place, sorted by specifier' },
    ],
    help: `
Enforces ui/AGENTS.md's icon-import rule, generalised: a named import from a
barrel module makes tsc resolve every module the barrel re-exports (300+ files
for a heroicons set) even though one is used. Importing the single module
directly costs one file.

  import { XMarkIcon } from '@heroicons/react/24/outline';        // barrel
  import XMarkIcon from '@heroicons/react/24/outline/XMarkIcon';  // one file

Built-in barrel patterns: ${BUILTIN_BARRELS.join(' ')}
Add your own with --barrel=<glob> (repeatable), or replace them entirely with
--barrel=... --no-builtin-barrels.

Every rewrite is verified before it is offered: '<specifier>/<name>' has to
resolve through the project's real module resolution (so tsconfig 'paths'
mappings are honoured) *and* the module it resolves to has to have a default
export. A specifier that fails either check is reported, never rewritten.

--fix rewrites a declaration only when every one of its named specifiers passes
and it carries no default/namespace import; the emitted lines are sorted
alphabetically by module specifier. Anything else is left for you.`,

    create(options: Options) {
        const patterns = (options.noBuiltins ? [] : BUILTIN_BARRELS).concat(options.barrels as string[]);
        const matchers = patterns.map(globToRegExp);
        const hits: Hit[] = [];
        const edits = new Map<string, FileEdit>(); // file -> { text, edits: [{ start, end, replacement }] }
        const defaultExportCache = new Map<string, boolean>();

        return {
            visit({ project, sourceFiles }) {
                if (matchers.length === 0) return;
                const host = project.getModuleResolutionHost?.() ?? ts.sys;

                for (const sourceFile of sourceFiles) {
                    const filePath = sourceFile.getFilePath();
                    for (const decl of sourceFile.getImportDeclarations()) {
                        const moduleSpecifier = decl.getModuleSpecifierValue();
                        if (!matchers.some(m => m.test(moduleSpecifier))) continue;
                        const named = decl.getNamedImports();
                        if (named.length === 0) continue;

                        const declTypeOnly = decl.isTypeOnly();
                        const quote = decl.getModuleSpecifier().getText()[0];
                        const rewrites: Rewrite[] = [];
                        const blocked: Blocked[] = [];
                        for (const spec of named) {
                            const exportName = spec.getName();
                            const local = spec.getAliasNode()?.getText() ?? exportName;
                            const deep = `${moduleSpecifier}/${exportName}`;
                            const resolvedFile = resolveDeep(deep, filePath, project, host);
                            if (!resolvedFile) {
                                blocked.push({ name: exportName, reason: `${deep} does not resolve` });
                                continue;
                            }
                            if (!hasDefaultExport(project, resolvedFile, defaultExportCache)) {
                                blocked.push({ name: exportName, reason: `${deep} has no default export` });
                                continue;
                            }
                            const typeOnly = declTypeOnly || spec.isTypeOnly();
                            rewrites.push({ deep, text: `import ${typeOnly ? 'type ' : ''}${local} from ${quote}${deep}${quote};` });
                        }
                        rewrites.sort((a, b) => a.deep.localeCompare(b.deep));

                        const carriesOther = decl.getDefaultImport() !== undefined || decl.getNamespaceImport() !== undefined;
                        if (carriesOther) blocked.push({ name: '*', reason: 'declaration also has a default/namespace import' });
                        const fixable = rewrites.length === named.length && !carriesOther;

                        hits.push({ file: filePath, line: decl.getStartLineNumber(), moduleSpecifier, count: named.length, rewrites, blocked, fixable });

                        if (options.fix && fixable) {
                            if (!edits.has(filePath)) edits.set(filePath, { text: sourceFile.getFullText(), list: [] });
                            edits.get(filePath)!.list.push({ start: decl.getStart(), end: decl.getEnd(), replacement: rewrites.map(r => r.text).join('\n') });
                        }
                    }
                }
            },
            report() {
                if (matchers.length === 0) {
                    console.log('no barrel patterns configured (--no-builtin-barrels without --barrel)');
                    return;
                }
                console.log(`barrels: ${patterns.join(' ')}`);
                hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
                for (const h of hits) {
                    console.log(`\n${h.file}:${h.line}  ${h.count} named import(s) from '${h.moduleSpecifier}'`);
                    for (const r of h.rewrites) console.log(`  ${options.fix && h.fixable ? 'fixed' : '  ->'}  ${r.text}`);
                    for (const b of h.blocked) console.log(`  skip   ${b.name}: ${b.reason}`);
                }

                for (const [filePath, { text, list }] of edits) {
                    let out = text;
                    for (const e of [...list].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
                    writeFileSync(filePath, out);
                }

                const specifierCount = hits.reduce((n, h) => n + h.count, 0);
                const notFixable = hits.filter(h => !h.fixable).length;
                console.log(`\n${hits.length} barrel import(s), ${specifierCount} specifier(s)`);
                if (options.fix) console.log(`${edits.size} file(s) rewritten${notFixable > 0 ? `, ${notFixable} declaration(s) left alone` : ''}`);
                else if (hits.length > 0) console.log(`re-run with --fix to rewrite the ${hits.length - notFixable} fixable declaration(s)`);
            },
        };
    },
};

export default explicitImport;
