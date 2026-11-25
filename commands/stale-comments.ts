import { readFileSync } from 'node:fs';
import { LANG_FLAG, SCOPE_FLAG } from '../lib/args.ts';
import { diffHunks, type Hunk, scopeLabel } from '../lib/git.ts';
import { goCommentBlocks } from '../lib/go-comments.ts';
import type { Command, Options } from '../lib/types.ts';
import { commentBlocks } from './comments.ts';

interface Block {
    startLine: number;
    endLine: number;
    pos: number;
    end: number;
}

interface StaleResult {
    file: string;
    startLine: number;
    endLine: number;
    reason: string;
}

// a doc comment speaks for the start of what it documents, not for every line of a long body
const SUBJECT_LINES = 10;

const indentOf = (line: string) => line.length - line.trimStart().length;

// the statement or declaration a comment sits on: its first line, the deeper-indented lines after it, and a closing
// bracket back at its own indent
function subjectEnd(lines: string[], first: number): number {
    const baseIndent = indentOf(lines[first - 1] ?? '');
    let end = first;
    for (let line = first + 1; line < first + SUBJECT_LINES && line <= lines.length; line++) {
        const text = lines[line - 1] ?? '';
        if (text.trim() === '') continue;
        const indent = indentOf(text);
        if (indent > baseIndent) end = line;
        else {
            if (indent === baseIndent && /^[}\])]/.test(text.trimStart())) end = line;
            break;
        }
    }
    return end;
}

function staleBlocks(file: string, text: string, blocks: Block[], hunks: Hunk[], results: StaleResult[]): void {
    const changed = new Set<number>();
    const deletedBefore = new Set<number>();
    for (const hunk of hunks) {
        if (hunk.count === 0) deletedBefore.add(hunk.start);
        for (let offset = 0; offset < hunk.count; offset++) changed.add(hunk.start + offset);
    }
    if (changed.size === 0 && deletedBefore.size === 0) return;
    const lines = text.split('\n');
    for (const block of blocks) {
        const lineStart = text.lastIndexOf('\n', block.pos - 1) + 1;
        const comment = text.slice(block.pos, block.end).trim();
        if (text.slice(lineStart, block.pos).trim() !== '') {
            // a trailing comment on a changed line that a removed line of the same hunk already carried
            if (!changed.has(block.startLine)) continue;
            const hunk = hunks.find(candidate => block.startLine >= candidate.start && block.startLine < candidate.start + candidate.count);
            if (hunk?.removed.some(removed => removed.includes(comment)))
                results.push({ file, startLine: block.startLine, endLine: block.endLine, reason: 'code on its line changed, the trailing comment did not' });
            continue;
        }
        let touched = false;
        for (let line = block.startLine; line <= block.endLine; line++) if (changed.has(line)) touched = true;
        const first = block.endLine + 1;
        // a comment followed by a blank line heads a section or file, not one statement; one over a Go group
        // (`const (`) speaks for the group, which a new member rarely contradicts
        const firstLine = lines[first - 1] ?? '';
        if (touched || firstLine.trim() === '' || /^\s*(const|var|type|import)\s*\($/.test(firstLine)) continue;
        const last = subjectEnd(lines, first);
        for (let line = first; line <= last; line++) {
            if (changed.has(line) || deletedBefore.has(line)) {
                results.push({ file, startLine: block.startLine, endLine: block.endLine, reason: `code below changed at :${line}, the comment did not` });
                break;
            }
        }
    }
}

function report(results: StaleResult[], scope: Options['scope']): void {
    results.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
    console.log(`comments next to changed code in ${scopeLabel(scope)}:`);
    for (const hit of results) console.log(`${hit.file}:${hit.endLine > hit.startLine ? `${hit.startLine}-${hit.endLine}` : hit.startLine}  (${hit.reason})`);
    console.log(`\n${results.length} candidate(s)`);
}

function needsDiff(options: Options): boolean {
    if (options.scope !== 'all') return true;
    console.log('stale-comments compares a comment with the code changed beside it, it needs --scope=uncommitted or --scope=<rev>');
    return false;
}

const staleComments: Command = {
    name: 'stale-comments',
    summary: 'comments whose code changed while they did not (are they still true?)',
    flags: [SCOPE_FLAG, LANG_FLAG],
    help: `
Flags a comment that the diff left alone while it changed the code the comment
is about, so it may describe what the code no longer does:
  - an own-line comment whose statement or declaration below it changed: its
    first line, the deeper-indented lines after it and a closing bracket at its
    indent, at most ${SUBJECT_LINES} lines (a doc comment speaks for the start of a body)
  - a trailing comment on a changed line that the removed line already carried
A comment followed by a blank line heads a section, not one statement, and one
over a Go \`const (\`/\`var (\`/\`type (\` group speaks for the group: both are skipped. Re-read each hit against the code: most still hold.

Needs a diff: --scope=uncommitted (default) or --scope=<rev>; --scope=all has
nothing to compare against.

Output:
  file:line[-endLine]  (code below changed at :N, the comment did not)`,

    create(options: Options) {
        const results: StaleResult[] = [];
        const active = needsDiff(options);
        return {
            visit({ sourceFiles }) {
                if (!active) return;
                for (const sourceFile of sourceFiles) {
                    const file = sourceFile.getFilePath();
                    const hunks = diffHunks(file, options.scope);
                    if (!hunks || hunks.length === 0) continue;
                    const blocks = commentBlocks(sourceFile).map(block => ({
                        ...block,
                        startLine: sourceFile.getLineAndColumnAtPos(block.pos).line,
                        endLine: sourceFile.getLineAndColumnAtPos(block.end - 1).line,
                    }));
                    staleBlocks(file, sourceFile.getFullText(), blocks, hunks, results);
                }
            },
            report() {
                if (active) report(results, options.scope);
            },
        };
    },

    createGo(options: Options) {
        const results: StaleResult[] = [];
        const active = needsDiff(options);
        return {
            visit(filePaths: string[]) {
                if (!active) return;
                for (const file of filePaths) {
                    const hunks = diffHunks(file, options.scope);
                    if (!hunks || hunks.length === 0) continue;
                    const text = readFileSync(file, 'utf8');
                    staleBlocks(file, text, goCommentBlocks(text), hunks, results);
                }
            },
            report() {
                if (active) report(results, options.scope);
            },
        };
    },
};

export default staleComments;
