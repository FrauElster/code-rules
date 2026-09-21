import { type Identifier, Node, type SourceFile, SyntaxKind } from 'ts-morph';
import { LANG_FLAG } from '../lib/args.ts';
import { analyzeGoInline } from '../lib/go-analyzer.ts';
import type { Command, Options } from '../lib/types.ts';

const FUNCTION_KINDS = [SyntaxKind.FunctionDeclaration, SyntaxKind.MethodDeclaration, SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression];

function enclosingFunction(node: Node): Node | null {
    let current = node.getParent();
    while (current) {
        if (FUNCTION_KINDS.includes(current.getKind())) return current;
        current = current.getParent();
    }
    return null;
}

function singleEnclosingFunction(nameNode: Identifier): { fn: Node; useCount: number } | null {
    const refs = nameNode.findReferencesAsNodes().filter(r => r.getStart() !== nameNode.getStart() || r.getSourceFile() !== nameNode.getSourceFile());
    if (refs.length === 0) return null;
    const enclosing = refs.map(enclosingFunction);
    if (enclosing.some(e => e === null)) return null;
    return enclosing.every(e => e === enclosing[0]) ? { fn: enclosing[0]!, useCount: refs.length } : null;
}

function bodyLineCount(body: Node | undefined): number | null {
    if (!body) return null;
    if (Node.isBlock(body)) {
        const statements = body.getStatements();
        if (statements.length === 0) return 0;
        return statements[statements.length - 1]!.getEndLineNumber() - statements[0]!.getStartLineNumber() + 1;
    }
    return body.getStartLineNumber() === body.getEndLineNumber() ? 1 : body.getEndLineNumber() - body.getStartLineNumber() + 1;
}

function callerCount(nameNode: Identifier): number {
    const refs = nameNode.findReferencesAsNodes();
    return refs.filter(r => r.getStart() !== nameNode.getStart() || r.getSourceFile() !== nameNode.getSourceFile()).length;
}

// arrow/function-expressions have no name of their own — recover it from a `const x = () => {}` parent
function functionDisplayName(fn: Node): string {
    if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) return fn.getName() ?? '<anonymous>';
    const parent = fn.getParent();
    if (Node.isVariableDeclaration(parent)) return parent.getName();
    return '<anonymous>';
}

interface Candidate {
    kind: 'function' | 'const';
    nameNode: Identifier;
    name: string;
    body: Node | undefined;
    exported: boolean;
}

function* candidatesInFile(sourceFile: SourceFile): Generator<Candidate> {
    for (const fn of sourceFile.getFunctions()) {
        const nameNode = fn.getNameNode();
        const body = fn.getBody();
        if (!nameNode || !body) continue;
        yield { kind: 'function', nameNode, name: nameNode.getText(), body, exported: fn.isExported() };
    }

    for (const varStatement of sourceFile.getVariableStatements()) {
        if (varStatement.getParent().getKind() !== SyntaxKind.SourceFile) continue;
        const isConst = varStatement.getDeclarationKind() === 'const';
        for (const decl of varStatement.getDeclarations()) {
            const init = decl.getInitializer();
            if (!init) continue;
            const nameNode = decl.getNameNode();
            if (!Node.isIdentifier(nameNode)) continue; // destructuring pattern, not a single named binding
            if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
                yield { kind: 'function', nameNode, name: decl.getName(), body: init.getBody(), exported: varStatement.isExported() };
            } else if (isConst) {
                yield { kind: 'const', nameNode, name: decl.getName(), body: undefined, exported: varStatement.isExported() };
            }
        }
    }
}

interface FunctionResult {
    kind: 'function';
    file: string;
    line: number;
    name: string;
    lines: number;
    exported: boolean;
}

interface ConstResult {
    kind: 'const';
    file: string;
    line: number;
    name: string;
    useCount: number;
    usedIn: string;
    usedInLine: number;
    exported: boolean;
}

type Result = FunctionResult | ConstResult;

function reportResults(results: Result[]): void {
    results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    for (const r of results) {
        const detail = r.kind === 'function' ? `(body ${r.lines}l)` : `(used ${r.useCount}x in ${r.usedIn}() at :${r.usedInLine})`;
        console.log(`${r.file}:${r.line}  ${r.name}  ${detail}${r.exported ? '  [exported]' : ''}`);
    }
    console.log(`\n${results.length} candidate(s)`);
}

const inline: Command = {
    name: 'inline',
    summary: 'top-level functions/consts used from exactly one place',
    flags: [
        { flag: '--max-lines=N', key: 'maxLines', kind: 'number', default: 5, desc: 'max function body lines to flag; consts are unbounded' },
        { flag: '--include-exported', key: 'includeExported', kind: 'boolean', default: false, desc: 'also flag exported bindings (cross-package callers are invisible)' },
        LANG_FLAG,
    ],
    help: `
Flags candidates for AGENTS.md's "inline single-caller helper" and "inline
single-caller top-level consts" rules:

  - functions / const-arrows whose body fits --max-lines and that have exactly
    one reference outside their own declaration
  - top-level consts whose every reference sits inside the *same* enclosing
    function (moving the const into that body is a straight inline regardless
    of how many times it's used there)

Output:
  file:line  name  (body Nl)                          [exported]
  file:line  name  (used Nx in fn() at :line)         [exported]

A hit is a place to look, not a verdict — independently testable, or genuinely
naming something, is a reason to keep a binding top-level.

  --lang=ts  default, auto-detected from the path (a go.mod makes it go). Path
             is a tsconfig/dir, scanned via ts-morph — reference counts come
             from the real symbol graph.
  --lang=go  path is a dir walked for *.go (or an individual .go file); no
             tsconfig, no type graph. Runs go-analyzer/main.go (go/ast, stdlib
             only) as a subprocess via \`go run\` — needs the go toolchain on
             PATH. References are matched by identifier name within the same
             package (directory), not by symbol: a local variable shadowing a
             top-level name can be miscounted. Methods (funcs with a receiver)
             and func-literal top-level vars aren't candidates, matching the
             ts-morph side's "top-level function/const" scope.`,

    // used by cli.ts's Go path (bypasses ts-morph/eachProject entirely — see resolveGoFiles)
    createGo(options: Options) {
        const results: Result[] = [];
        return {
            visit(filePaths: string[]) {
                for (const c of analyzeGoInline(filePaths)) {
                    if (c.exported && !options.includeExported) continue;
                    if (c.kind === 'func') {
                        if (c.bodyLines > (options.maxLines as number)) continue;
                        results.push({ kind: 'function', file: c.file, line: c.line, name: c.name, lines: c.bodyLines, exported: c.exported });
                    } else {
                        results.push({ kind: 'const', file: c.file, line: c.line, name: c.name, useCount: c.useCount, usedIn: c.usedIn, usedInLine: c.usedInLine, exported: c.exported });
                    }
                }
            },
            report() {
                reportResults(results);
            },
        };
    },

    create(options: Options) {
        const results: Result[] = [];
        return {
            visit({ sourceFiles }) {
                for (const sourceFile of sourceFiles) {
                    const filePath = sourceFile.getFilePath();
                    for (const c of candidatesInFile(sourceFile)) {
                        if (c.exported && !options.includeExported) continue;

                        if (c.kind === 'function') {
                            const lines = bodyLineCount(c.body);
                            if (lines === null || lines > (options.maxLines as number)) continue;
                            if (callerCount(c.nameNode) !== 1) continue;
                            results.push({ kind: 'function', file: filePath, line: c.nameNode.getStartLineNumber(), name: c.name, lines, exported: c.exported });
                            continue;
                        }

                        const single = singleEnclosingFunction(c.nameNode);
                        if (!single) continue;
                        results.push({
                            kind: 'const',
                            file: filePath,
                            line: c.nameNode.getStartLineNumber(),
                            name: c.name,
                            useCount: single.useCount,
                            usedIn: functionDisplayName(single.fn),
                            usedInLine: single.fn.getStartLineNumber(),
                            exported: c.exported,
                        });
                    }
                }
            },
            report() {
                reportResults(results);
            },
        };
    },
};

export default inline;
