import { Node, type SourceFile, SyntaxKind } from 'ts-morph';
import { LANG_FLAG, SCOPE_FLAG } from '../lib/args.ts';
import { addedLines } from '../lib/git.ts';
import { analyzeGoSingleLetter } from '../lib/go-analyzer.ts';
import type { Command, Options } from '../lib/types.ts';

type Kind = 'variable' | 'parameter' | 'catch';

interface Hit {
    kind: Kind;
    nameNode: Node;
    name: string;
}

function* candidatesInFile(sourceFile: SourceFile, allow: ReadonlySet<string>): Generator<Hit> {
    const flaggable = (name: string) => name.length === 1 && !allow.has(name);

    for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        if (Node.isCatchClause(decl.getParent())) continue; // a catch binding is a VariableDeclaration too — reported as 'catch' below
        const nameNode = decl.getNameNode();
        if (Node.isIdentifier(nameNode) && flaggable(nameNode.getText())) yield { kind: 'variable', nameNode, name: nameNode.getText() };
    }

    for (const param of sourceFile.getDescendantsOfKind(SyntaxKind.Parameter)) {
        const nameNode = param.getNameNode();
        if (Node.isIdentifier(nameNode) && flaggable(nameNode.getText())) yield { kind: 'parameter', nameNode, name: nameNode.getText() };
    }

    for (const catchClause of sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause)) {
        const nameNode = catchClause.getVariableDeclaration()?.getNameNode();
        if (nameNode && Node.isIdentifier(nameNode) && flaggable(nameNode.getText())) yield { kind: 'catch', nameNode, name: nameNode.getText() };
    }
}

interface Result {
    kind: Kind;
    file: string;
    line: number;
    name: string;
}

function report(results: Result[]): void {
    results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const width = Math.max(0, ...results.map(r => r.kind.length));
    for (const r of results) console.log(`${r.file}:${r.line}  ${r.kind.padEnd(width)}  ${r.name}`);
    console.log(`\n${results.length} candidate(s)`);
}

const singleLetter: Command = {
    name: 'single-letter',
    summary: 'variables/parameters named with a single letter',
    flags: [
        SCOPE_FLAG,
        LANG_FLAG,
        { flag: '--kind=all|variable|parameter|catch', key: 'kind', kind: 'enum', values: ['all', 'variable', 'parameter', 'catch'], default: 'all', desc: 'which binding kind to report' },
        { flag: '--allow=<names>', key: 'allow', kind: 'list', default: ['_'], desc: "names to exempt (comma-free: repeat the flag); default exempts only '_'" },
    ],
    help: `
Flags single-character identifiers bound by \`let\`/\`const\`/\`var\`, a function/
method/arrow parameter, or a \`catch\` clause. A name that short carries no
information a reader can recover without tracing every use back to its
declaration — the fix is almost always a name that says what the value is.

  --scope=uncommitted  only bindings on a line added/modified since HEAD
  --scope=all          the whole project
  --kind=...           report one binding kind instead of all three
  --allow=<name>        repeatable; exempts a specific name everywhere (e.g.
                       --allow=_ --allow=i for an accepted loop counter)
  --lang=ts            default, auto-detected from the path (a go.mod makes
                       it go). Path is a tsconfig/dir, scanned via ts-morph.
  --lang=go            path is a dir walked for *.go (or an individual .go file).
                       variable: \`:=\`, var/const, range key/value, type-switch
                       binding; parameter: func params and named results. Method
                       receivers are skipped (Go convention keeps them short), and
                       there is no catch kind.

Output:
  file:line  kind  name

A hit is a place to look, not a verdict — a well-known convention (\`_\` for an
ignored binding, \`i\`/\`j\` in a tight nested-loop) can be a deliberate exception;
add it to --allow rather than treating every hit as a rename.`,

    create(options: Options) {
        const results: Result[] = [];
        const checkAll = options.scope === 'all';
        const kindFilter = options.kind as string;
        const allow = new Set(options.allow as string[]);
        return {
            visit({ sourceFiles }) {
                for (const sourceFile of sourceFiles) {
                    const filePath = sourceFile.getFilePath();
                    const added = checkAll ? null : addedLines(filePath);
                    if (!checkAll && (added === null || added.size === 0)) continue;

                    for (const hit of candidatesInFile(sourceFile, allow)) {
                        if (kindFilter !== 'all' && hit.kind !== kindFilter) continue;
                        const line = hit.nameNode.getStartLineNumber();
                        if (!checkAll && !added?.has(line)) continue;
                        results.push({ kind: hit.kind, file: filePath, line, name: hit.name });
                    }
                }
            },
            report: () => report(results),
        };
    },

    // used by cli.ts's Go path (bypasses ts-morph/eachProject entirely — see resolveGoFiles)
    createGo(options: Options) {
        const results: Result[] = [];
        const checkAll = options.scope === 'all';
        const kindFilter = options.kind as string;
        const allow = new Set(options.allow as string[]);
        return {
            visit(filePaths: string[]) {
                const addedByFile = new Map<string, Set<number> | null>();
                for (const hit of analyzeGoSingleLetter(filePaths)) {
                    if (allow.has(hit.name) || (kindFilter !== 'all' && hit.kind !== kindFilter)) continue;
                    if (!checkAll) {
                        if (!addedByFile.has(hit.file)) addedByFile.set(hit.file, addedLines(hit.file));
                        if (!addedByFile.get(hit.file)?.has(hit.line)) continue;
                    }
                    results.push(hit);
                }
            },
            report: () => report(results),
        };
    },
};

export default singleLetter;
