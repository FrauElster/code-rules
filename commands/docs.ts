import { existsSync, readFileSync, statSync } from 'node:fs';
import { SCOPE_FLAG } from '../lib/args.ts';
import { findFilesRecursive } from '../lib/files.ts';
import { addedLines, scopeLabel } from '../lib/git.ts';
import type { Command, Options } from '../lib/types.ts';
import { HISTORY } from './comments.ts';

interface DocResult {
    file: string;
    line: number;
    match: string;
}

// a doc sentence with "no longer" describes a change far more often than a code comment does
const DOC_HISTORY = new RegExp(`${HISTORY.source}|\\bno longer\\b`, 'i');

const docs: Command = {
    name: 'docs',
    summary: 'changelog wording in Markdown docs (they describe the current state only)',
    flags: [SCOPE_FLAG],
    help: `
Scans the given Markdown files, or every *.md under the given directories
(node_modules/, .git/, vendor/ skipped), for wording that describes how the
code got where it is instead of what it is: "previously", "used to be",
"was changed/replaced/removed/renamed", "phase N", "no longer". Fenced code
blocks are skipped.

A hit is a candidate: "no longer" can describe a state of the domain ("targets
no longer exported are unregistered") rather than a change of the code.

Output:
  file:line  'matched wording'  line text`,

    run(options: Options, paths: string[]) {
        if (paths.length === 0) {
            console.error('docs: no Markdown file or directory given');
            process.exit(1);
        }
        const checkAll = options.scope === 'all';
        const results: DocResult[] = [];
        const texts = new Map<string, string[]>();
        for (const path of paths) {
            if (!existsSync(path)) {
                console.error(`path not found: ${path}`);
                process.exit(1);
            }
            const files = statSync(path).isDirectory() ? findFilesRecursive(path, '.md') : [path];
            for (const file of files) {
                const added = checkAll ? null : addedLines(file, options.scope);
                if (!checkAll && (added === null || added.size === 0)) continue;
                const lines = readFileSync(file, 'utf8').split('\n');
                texts.set(file, lines);
                let fenced = false;
                for (const [index, text] of lines.entries()) {
                    if (/^\s*(```|~~~)/.test(text)) fenced = !fenced;
                    if (fenced || (added && !added.has(index + 1))) continue;
                    const match = DOC_HISTORY.exec(text.replace(/`[^`]*`/g, ' '));
                    if (match) results.push({ file, line: index + 1, match: match[0] });
                }
            }
        }
        results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
        console.log(`changelog wording in ${scopeLabel(options.scope)}:`);
        for (const hit of results) console.log(`${hit.file}:${hit.line}  '${hit.match}'  ${texts.get(hit.file)?.[hit.line - 1]?.trim().slice(0, 120)}`);
        console.log(`\n${results.length} candidate(s)`);
    },
};

export default docs;
