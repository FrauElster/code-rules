import { extname } from 'node:path';
import { readFileSync } from 'node:fs';
import { ts } from 'ts-morph';
import { SCOPE_FLAG } from '../lib/args.js';
import { addedLines } from '../lib/git.js';
import { goCommentBlocks } from '../lib/go-comments.js';

const LANG_FLAG = { flag: '--lang=ts|go', key: 'lang', kind: 'enum', values: ['ts', 'go'], default: 'ts', desc: 'which project graph to scan: TypeScript (ts-morph, needs a tsconfig/dir) or Go (needs a dir/*.go, no type graph)' };

// groups `//` lines that are truly adjacent (consecutive source lines, nothing but trivia between them) into one
// logical comment, since that's what the "hard cap ~1 line" comment-style rule treats as a single unit; a blank
// line between two `//` comments makes them two separate comments, not one. `/* */` is always one unit.
function commentBlocks(sourceFile, isJsx) {
    const fullText = sourceFile.getFullText();
    const lineAt = pos => sourceFile.getLineAndColumnAtPos(pos).line;
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, isJsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, fullText);
    const blocks = [];
    let currentLineBlock = null;
    let currentLineBlockEndLine = -1;
    let codeSincePrevComment = true;
    let kind = scanner.scan();
    while (kind !== ts.SyntaxKind.EndOfFileToken) {
        if (kind === ts.SyntaxKind.SingleLineCommentTrivia) {
            const pos = scanner.getTokenPos();
            const end = scanner.getTextPos();
            const startLine = lineAt(pos);
            if (currentLineBlock && !codeSincePrevComment && startLine === currentLineBlockEndLine + 1) currentLineBlock.end = end;
            else {
                currentLineBlock = { pos, end };
                blocks.push(currentLineBlock);
            }
            currentLineBlockEndLine = lineAt(end - 1);
            codeSincePrevComment = false;
        } else if (kind === ts.SyntaxKind.MultiLineCommentTrivia) {
            blocks.push({ pos: scanner.getTokenPos(), end: scanner.getTextPos() });
            currentLineBlock = null;
            codeSincePrevComment = false;
        } else if (kind !== ts.SyntaxKind.WhitespaceTrivia && kind !== ts.SyntaxKind.NewLineTrivia) {
            currentLineBlock = null;
            codeSincePrevComment = true;
        }
        kind = scanner.scan();
    }
    return blocks;
}

function reportBlocks(results, checkAll) {
    results.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
    console.log(`multi-line comments in ${checkAll ? 'the whole project' : 'uncommitted lines'}:`);
    for (const r of results) console.log(`${r.file}:${r.startLine}-${r.endLine}  (${r.endLine - r.startLine + 1}l comment)`);
    console.log(`\n${results.length} candidate(s)`);
}

export default {
    name: 'comments',
    summary: 'multi-line comments (hard cap ~1 line rule)',
    flags: [SCOPE_FLAG, LANG_FLAG],
    help: `
Flags every comment (a /* */ block, or a run of adjacent // lines treated as one
logical comment) spanning more than one physical line, per AGENTS.md's "comments
only for unexpected/non-obvious behaviour ... hard cap ~1 line" rule.

  --scope=uncommitted  only comments overlapping a line added/modified since HEAD
                       (staged, unstaged, or a wholly-new untracked file) — this
                       is your own in-flight work, not a codebase audit
  --scope=all          every multi-line comment, ignoring git state entirely
                       (no git calls are made)
  --lang=ts            default. Path is a tsconfig/dir, scanned via ts-morph.
  --lang=go            path is a dir walked for *.go (or an individual .go file);
                       no type graph, no tsconfig — vendor/, node_modules/, .git/
                       and generated files ("// Code generated ... DO NOT EDIT.")
                       are skipped. // and /* */ both count.

Output:
  file:startLine-endLine  (Nl comment)

JSDoc-style API docs on an exported symbol are a legitimate reason to keep one.`,

    // used by cli.js's Go path (bypasses ts-morph/eachProject entirely — see resolveGoFiles)
    createGo(options) {
        const results = [];
        const checkAll = options.scope === 'all';
        return {
            visit(filePath) {
                const text = readFileSync(filePath, 'utf8');
                const blocks = goCommentBlocks(text);
                if (blocks.length === 0) return;

                const added = checkAll ? null : addedLines(filePath);
                if (!checkAll && (added === null || added.size === 0)) return;

                for (const b of blocks) {
                    if (b.endLine <= b.startLine) continue;
                    if (!checkAll) {
                        let overlapsAdded = false;
                        for (let l = b.startLine; l <= b.endLine; l++) {
                            if (added.has(l)) {
                                overlapsAdded = true;
                                break;
                            }
                        }
                        if (!overlapsAdded) continue;
                    }
                    results.push({ file: filePath, startLine: b.startLine, endLine: b.endLine });
                }
            },
            report() {
                reportBlocks(results, checkAll);
            },
        };
    },

    create(options) {
        const results = [];
        const checkAll = options.scope === 'all';
        return {
            visit({ sourceFiles }) {
                for (const sourceFile of sourceFiles) {
                    const filePath = sourceFile.getFilePath();
                    const isJsx = extname(filePath) === '.tsx' || extname(filePath) === '.jsx';
                    const blocks = commentBlocks(sourceFile, isJsx);
                    if (blocks.length === 0) continue;

                    const added = checkAll ? null : addedLines(filePath);
                    if (!checkAll && (added === null || added.size === 0)) continue;

                    for (const b of blocks) {
                        const startLine = sourceFile.getLineAndColumnAtPos(b.pos).line;
                        const endLine = sourceFile.getLineAndColumnAtPos(b.end - 1).line;
                        if (endLine <= startLine) continue;
                        if (!checkAll) {
                            let overlapsAdded = false;
                            for (let l = startLine; l <= endLine; l++) {
                                if (added.has(l)) {
                                    overlapsAdded = true;
                                    break;
                                }
                            }
                            if (!overlapsAdded) continue;
                        }
                        results.push({ file: filePath, startLine, endLine });
                    }
                }
            },
            report() {
                reportBlocks(results, checkAll);
            },
        };
    },
};
