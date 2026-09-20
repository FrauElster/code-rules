import { SyntaxKind } from 'ts-morph';

const FUNCTION_KINDS = [SyntaxKind.FunctionDeclaration, SyntaxKind.MethodDeclaration, SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression];

function enclosingFunction(node) {
    let current = node.getParent();
    while (current) {
        if (FUNCTION_KINDS.includes(current.getKind())) return current;
        current = current.getParent();
    }
    return null;
}

function singleEnclosingFunction(nameNode) {
    const refs = nameNode.findReferencesAsNodes().filter(r => r.getStart() !== nameNode.getStart() || r.getSourceFile() !== nameNode.getSourceFile());
    if (refs.length === 0) return null;
    const enclosing = refs.map(enclosingFunction);
    if (enclosing.some(e => e === null)) return null;
    return enclosing.every(e => e === enclosing[0]) ? { fn: enclosing[0], useCount: refs.length } : null;
}

function bodyLineCount(body) {
    if (!body) return null;
    if (body.getKind() === SyntaxKind.Block) {
        const statements = body.getStatements();
        if (statements.length === 0) return 0;
        return statements[statements.length - 1].getEndLineNumber() - statements[0].getStartLineNumber() + 1;
    }
    return body.getStartLineNumber() === body.getEndLineNumber() ? 1 : body.getEndLineNumber() - body.getStartLineNumber() + 1;
}

function callerCount(nameNode) {
    const refs = nameNode.findReferencesAsNodes();
    return refs.filter(r => r.getStart() !== nameNode.getStart() || r.getSourceFile() !== nameNode.getSourceFile()).length;
}

// arrow/function-expressions have no name of their own — recover it from a `const x = () => {}` parent
function functionDisplayName(fn) {
    if (fn.getKind() === SyntaxKind.FunctionDeclaration || fn.getKind() === SyntaxKind.MethodDeclaration) return fn.getName() ?? '<anonymous>';
    const parent = fn.getParent();
    if (parent && parent.getKind() === SyntaxKind.VariableDeclaration) return parent.getName();
    return '<anonymous>';
}

function* candidatesInFile(sourceFile) {
    for (const fn of sourceFile.getFunctions()) {
        const nameNode = fn.getNameNode();
        if (!nameNode || !fn.getBody()) continue;
        yield { kind: 'function', nameNode, name: nameNode.getText(), body: fn.getBody(), exported: fn.isExported() };
    }

    for (const varStatement of sourceFile.getVariableStatements()) {
        if (varStatement.getParent().getKind() !== SyntaxKind.SourceFile) continue;
        const isConst = varStatement.getDeclarationKind() === 'const';
        for (const decl of varStatement.getDeclarations()) {
            const init = decl.getInitializer();
            if (!init) continue;
            const initKind = init.getKind();
            const nameNode = decl.getNameNode();
            if (nameNode.getKind() !== SyntaxKind.Identifier) continue; // destructuring pattern, not a single named binding
            if (initKind === SyntaxKind.ArrowFunction || initKind === SyntaxKind.FunctionExpression) {
                yield { kind: 'function', nameNode, name: decl.getName(), body: init.getBody(), exported: varStatement.isExported() };
            } else if (isConst) {
                yield { kind: 'const', nameNode, name: decl.getName(), exported: varStatement.isExported() };
            }
        }
    }
}

export default {
    name: 'inline',
    summary: 'top-level functions/consts used from exactly one place',
    flags: [
        { flag: '--max-lines=N', key: 'maxLines', kind: 'number', default: 5, desc: 'max function body lines to flag; consts are unbounded' },
        { flag: '--include-exported', key: 'includeExported', kind: 'boolean', default: false, desc: 'also flag exported bindings (cross-package callers are invisible)' },
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
naming something, is a reason to keep a binding top-level.`,

    create(options) {
        const results = [];
        return {
            visit({ sourceFiles }) {
                for (const sourceFile of sourceFiles) {
                    const filePath = sourceFile.getFilePath();
                    for (const c of candidatesInFile(sourceFile)) {
                        if (c.exported && !options.includeExported) continue;

                        if (c.kind === 'function') {
                            const lines = bodyLineCount(c.body);
                            if (lines === null || lines > options.maxLines) continue;
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
                results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
                for (const r of results) {
                    const detail = r.kind === 'function' ? `(body ${r.lines}l)` : `(used ${r.useCount}x in ${r.usedIn}() at :${r.usedInLine})`;
                    console.log(`${r.file}:${r.line}  ${r.name}  ${detail}${r.exported ? '  [exported]' : ''}`);
                }
                console.log(`\n${results.length} candidate(s)`);
            },
        };
    },
};
