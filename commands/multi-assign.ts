import { Node, type SourceFile, SyntaxKind } from 'ts-morph';
import { LANG_FLAG, SCOPE_FLAG } from '../lib/args.ts';
import { addedLines, touchesAdded } from '../lib/git.ts';
import { analyzeGoMultiAssign, type GoSpanCandidate } from '../lib/go-analyzer.ts';
import type { Command, Options } from '../lib/types.ts';

// a swap/rotation (`[a, b] = [b, a]`) needs the parallel assignment — split up, it needs a temporary
function isPermutation(targets: Node[], values: Node[]): boolean {
    const counts = new Map<string, number>();
    for (const target of targets) counts.set(target.getText(), (counts.get(target.getText()) ?? 0) + 1);
    for (const value of values) counts.set(value.getText(), (counts.get(value.getText()) ?? 0) - 1);
    return [...counts.values()].every(count => count === 0);
}

function* candidatesInFile(sourceFile: SourceFile): Generator<Node> {
    for (const list of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclarationList)) {
        // `for (let i = 0, j = n - 1; ...)` — a for clause has room for only one statement
        if (Node.isForStatement(list.getParent())) continue;
        if (list.getDeclarations().filter(decl => decl.hasInitializer()).length > 1) yield list;
    }

    for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const initializer = decl.getInitializer();
        if (Node.isArrayBindingPattern(decl.getNameNode()) && Node.isArrayLiteralExpression(initializer) && initializer.getElements().length > 1) yield decl;
    }

    for (const binary of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (binary.getOperatorToken().getKind() !== SyntaxKind.EqualsToken || Node.isForStatement(binary.getParent())) continue;
        const left = binary.getLeft();
        const right = binary.getRight();
        if (!Node.isArrayLiteralExpression(left) || !Node.isArrayLiteralExpression(right) || right.getElements().length < 2) continue;
        if (!isPermutation(left.getElements(), right.getElements())) yield binary;
    }
}

function report(results: GoSpanCandidate[], checkAll: boolean): void {
    results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    console.log(`multiple assignments in one statement in ${checkAll ? 'the whole project' : 'uncommitted lines'}:`);
    for (const hit of results) {
        if (hit.endLine === hit.line) console.log(`${hit.file}:${hit.line}  ${hit.text}`);
        else console.log(`${hit.file}:${hit.line}-${hit.endLine}  ${hit.text.split('\n')[0]} …`);
    }
    console.log(`\n${results.length} candidate(s)`);
}

const multiAssign: Command = {
    name: 'multi-assign',
    summary: 'several values assigned in one statement (`x, y = 1, 2`), or a grouped Go `var (...)` in a func',
    flags: [SCOPE_FLAG, LANG_FLAG],
    help: `
Flags a statement that assigns several independent values at once:

  x, y, z := 1, "2", 3.0          // Go: flagged
  var a, b = f(), g()             // Go: flagged
  let a = 1, b = 2;               // TS: flagged
  const [a, b] = [1, 2];          // TS: flagged
  [a, b] = [1, 2];                // TS: flagged
  var ( a int; b string )         // Go: flagged inside a func, write one \`var\` per line

Not flagged: one call returning several values (\`v, err := f()\`,
\`const [a, b] = f()\`), a swap or rotation (\`a, b = b, a\`), and the init/post
clause of a \`for\` loop, which has room for only one statement. A grouped Go
\`const (...)\` block that uses iota or an implicit repeat is one enum, and a
package-level \`var (...)\` / \`const (...)\` block is fine too.

  --scope=uncommitted  only statements overlapping a line added/modified since HEAD
  --scope=all          the whole project
  --lang=ts|go         default auto-detected from the path

Output:
  file:line  statement
  file:line-endLine  first line of the statement …`,

    create(options: Options) {
        const results: GoSpanCandidate[] = [];
        const checkAll = options.scope === 'all';
        return {
            visit({ sourceFiles }) {
                for (const sourceFile of sourceFiles) {
                    const file = sourceFile.getFilePath();
                    const added = checkAll ? null : addedLines(file);
                    if (!checkAll && (added === null || added.size === 0)) continue;
                    for (const node of candidatesInFile(sourceFile)) {
                        const line = node.getStartLineNumber();
                        const endLine = node.getEndLineNumber();
                        if (!checkAll && !touchesAdded(added, line, endLine)) continue;
                        results.push({ file, line, endLine, text: node.getText() });
                    }
                }
            },
            report: () => report(results, checkAll),
        };
    },

    createGo(options: Options) {
        const results: GoSpanCandidate[] = [];
        const checkAll = options.scope === 'all';
        return {
            visit(filePaths: string[]) {
                const addedByFile = new Map<string, Set<number> | null>();
                for (const candidate of analyzeGoMultiAssign(filePaths)) {
                    if (!checkAll) {
                        if (!addedByFile.has(candidate.file)) addedByFile.set(candidate.file, addedLines(candidate.file));
                        if (!touchesAdded(addedByFile.get(candidate.file), candidate.line, candidate.endLine)) continue;
                    }
                    results.push(candidate);
                }
            },
            report: () => report(results, checkAll),
        };
    },
};

export default multiAssign;
