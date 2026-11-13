import { readFileSync } from 'node:fs';
import { type SourceFile, ts } from 'ts-morph';
import { LANG_FLAG, SCOPE_FLAG } from '../lib/args.ts';
import { addedLines } from '../lib/git.ts';
import { goCommentBlocks } from '../lib/go-comments.ts';
import type { Command, Options } from '../lib/types.ts';

interface TsCommentBlock {
    pos: number;
    end: number;
}

// groups `//` lines that are truly adjacent (consecutive source lines, nothing but trivia between them) into one
// logical comment, since that's what the "hard cap ~1 line" comment-style rule treats as a single unit; a blank
// line between two `//` comments makes them two separate comments, not one. `/* */` is always one unit.
function commentBlocks(sourceFile: SourceFile): TsCommentBlock[] {
    const fullText = sourceFile.getFullText();
    const compilerFile = sourceFile.compilerNode;
    const lineAt = (pos: number) => sourceFile.getLineAndColumnAtPos(pos).line;
    const blocks: TsCommentBlock[] = [];
    let currentLineBlock: TsCommentBlock | null = null;
    let currentLineBlockEndLine = -1;
    let codeSincePrevComment = true;

    const onComment = (pos: number, end: number, kind: ts.CommentKind) => {
        if (kind === ts.SyntaxKind.SingleLineCommentTrivia) {
            const startLine = lineAt(pos);
            if (currentLineBlock && !codeSincePrevComment && startLine === currentLineBlockEndLine + 1) currentLineBlock.end = end;
            else {
                currentLineBlock = { pos, end };
                blocks.push(currentLineBlock);
            }
            currentLineBlockEndLine = lineAt(end - 1);
        } else {
            blocks.push({ pos, end });
            currentLineBlock = null;
        }
        codeSincePrevComment = false;
    };
    const onCode = () => {
        currentLineBlock = null;
        codeSincePrevComment = true;
    };

    // a whole-file scan loses template literals after `${}` and misreads `//` in regexes, so only gaps between nodes are lexed
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, compilerFile.languageVariant, fullText);
    const scanGap = (start: number, end: number) => {
        if (start >= end) return;
        scanner.resetTokenState(start);
        for (let kind = scanner.scan(); scanner.getTokenStart() < end && kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
            if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) onComment(scanner.getTokenStart(), scanner.getTokenEnd(), kind);
            else if (kind !== ts.SyntaxKind.WhitespaceTrivia && kind !== ts.SyntaxKind.NewLineTrivia) onCode();
        }
    };
    const visit = (node: ts.Node) => {
        let cursor = node.pos;
        let hasChildren = false;
        ts.forEachChild(node, child => {
            hasChildren = true;
            scanGap(cursor, child.pos);
            visit(child);
            cursor = child.end;
        });
        // childless non-token nodes (`return;`, `debugger;`) hold only keywords and punctuation, safe to scan whole
        if (hasChildren || node.kind > ts.SyntaxKind.LastToken) scanGap(cursor, node.end);
        else {
            if (node.kind !== ts.SyntaxKind.JsxText) ts.forEachLeadingCommentRange(fullText, node.pos, onComment);
            if (node.kind !== ts.SyntaxKind.EndOfFileToken) onCode();
        }
    };
    visit(compilerFile);
    return blocks;
}

interface CommentResult {
    file: string;
    startLine: number;
    endLine: number;
    hints: string[];
}

// tool directives legitimately end in or contain punctuation (`@ts-expect-error: why`, `//go:build`, `/// <reference .../>`)
const DIRECTIVE = /^(eslint-|biome-ignore|@ts-|go:|nolint|prettier-ignore|istanbul |c8 |#(end)?region|\/ ?<reference|Code generated )/;
// periods that aren't sentence ends: code spans, urls, common abbreviations, `...` ellipses
const NON_PROSE = /`[^`]*`|\S+:\/\/\S+|\b(e\.g|i\.e|etc|vs|cf|approx)\.|\.{2,}/gi;

function proseHints(raw: string): string[] {
    const lines = raw
        .split('\n')
        .map(line =>
            line
                .trim()
                .replace(/^\/\/|^\/\*+|\*+\/$/g, '')
                .replace(/^\s*\*/, '')
                .trim(),
        )
        .filter(line => line !== '');
    if (lines.length === 0 || DIRECTIVE.test(lines[0]!)) return [];
    const text = lines.join(' ').replace(NON_PROSE, ' x ').trim();
    const hints: string[] = [];
    const trailing = /[.!?;]$/.exec(text);
    if (trailing) hints.push(`trailing '${trailing[0]}'`);
    if (/[.!?;]\s+\S/.test(text)) hints.push('sentence break');
    return hints;
}

function collect(results: CommentResult[], file: string, added: Set<number> | null, block: { startLine: number; endLine: number; text: string }): void {
    const { startLine, endLine } = block;
    if (added) {
        let overlapsAdded = false;
        for (let l = startLine; l <= endLine; l++) {
            if (added.has(l)) {
                overlapsAdded = true;
                break;
            }
        }
        if (!overlapsAdded) return;
    }
    const hints = proseHints(block.text);
    if (endLine > startLine) hints.unshift(`${endLine - startLine + 1}l comment`);
    if (hints.length > 0) results.push({ file, startLine, endLine, hints });
}

function reportBlocks(results: CommentResult[], checkAll: boolean): void {
    results.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
    console.log(`multi-line or prose comments in ${checkAll ? 'the whole project' : 'uncommitted lines'}:`);
    for (const r of results) {
        const range = r.endLine > r.startLine ? `${r.startLine}-${r.endLine}` : `${r.startLine}`;
        console.log(`${r.file}:${range}  (${r.hints.join(', ')})`);
    }
    console.log(`\n${results.length} candidate(s)`);
}

const comments: Command = {
    name: 'comments',
    summary: 'multi-line or prose-punctuated comments (~1 line fragment rule)',
    flags: [SCOPE_FLAG, LANG_FLAG],
    help: `
Flags every comment (a /* */ block, or a run of adjacent // lines treated as one
logical comment) that spans more than one physical line or reads like prose
instead of a terse fragment, per the "terse lowercase fragments, no trailing
period, ~1 line" comment rule. Prose hints:
  trailing '.'      ends like a sentence (also '!', '?', ';')
  sentence break    . ! ? or ; followed by more text mid-comment
Code spans, URLs, e.g./i.e./etc./vs., ellipses and tool directives (eslint-,
biome-ignore, @ts-, go:, nolint, ...) never count as prose.

  --scope=uncommitted  only comments overlapping a line added/modified since HEAD
                       (staged, unstaged, or a wholly-new untracked file) — this
                       is your own in-flight work, not a codebase audit
  --scope=all          every multi-line comment, ignoring git state entirely
                       (no git calls are made)
  --lang=ts            default, auto-detected from the path (a go.mod makes
                       it go). Path is a tsconfig/dir, scanned via ts-morph.
  --lang=go            path is a dir walked for *.go (or an individual .go file);
                       no type graph, no tsconfig — vendor/, node_modules/, .git/
                       and generated files ("// Code generated ... DO NOT EDIT.")
                       are skipped. // and /* */ both count.

Output:
  file:startLine-endLine  (Nl comment[, prose hints])
  file:line  (prose hints)

JSDoc-style API docs on an exported symbol are a legitimate reason to keep one.`,

    // used by cli.ts's Go path (bypasses ts-morph/eachProject entirely — see resolveGoFiles)
    createGo(options: Options) {
        const results: CommentResult[] = [];
        const checkAll = options.scope === 'all';
        return {
            visit(filePaths: string[]) {
                for (const filePath of filePaths) {
                    const text = readFileSync(filePath, 'utf8');
                    const blocks = goCommentBlocks(text);
                    if (blocks.length === 0) continue;

                    const added = checkAll ? null : addedLines(filePath);
                    if (!checkAll && (added === null || added.size === 0)) continue;

                    for (const b of blocks) collect(results, filePath, added, { ...b, text: text.slice(b.pos, b.end) });
                }
            },
            report() {
                reportBlocks(results, checkAll);
            },
        };
    },

    create(options: Options) {
        const results: CommentResult[] = [];
        const checkAll = options.scope === 'all';
        return {
            visit({ sourceFiles }) {
                for (const sourceFile of sourceFiles) {
                    const filePath = sourceFile.getFilePath();
                    const blocks = commentBlocks(sourceFile);
                    if (blocks.length === 0) continue;

                    const added = checkAll ? null : addedLines(filePath);
                    if (!checkAll && (added === null || added.size === 0)) continue;

                    const fullText = sourceFile.getFullText();
                    for (const b of blocks) {
                        collect(results, filePath, added, {
                            startLine: sourceFile.getLineAndColumnAtPos(b.pos).line,
                            endLine: sourceFile.getLineAndColumnAtPos(b.end - 1).line,
                            text: fullText.slice(b.pos, b.end),
                        });
                    }
                }
            },
            report() {
                reportBlocks(results, checkAll);
            },
        };
    },
};

export default comments;
