import { type Identifier, Node, type SourceFile } from 'ts-morph';
import { INCLUDE_EXPORTED_FLAG, LANG_FLAG } from '../lib/args.ts';
import { analyzeGoDeadCode } from '../lib/go-analyzer.ts';
import { isTestFile, withTestFiles } from '../lib/project.ts';
import type { Command, Options } from '../lib/types.ts';

interface Candidate {
    kind: string;
    nameNode: Identifier;
    declaration: Node;
    exported: boolean;
}

function* candidatesInFile(sourceFile: SourceFile): Generator<Candidate> {
    for (const fn of sourceFile.getFunctions()) {
        const nameNode = fn.getNameNode();
        if (nameNode && fn.hasBody()) yield { kind: 'function', nameNode, declaration: fn, exported: fn.isExported() };
    }
    for (const statement of sourceFile.getVariableStatements()) {
        if (statement.hasDeclareKeyword()) continue;
        for (const decl of statement.getDeclarations()) {
            const nameNode = decl.getNameNode();
            if (!Node.isIdentifier(nameNode)) continue; // destructuring pattern, not a single named binding
            const init = decl.getInitializer();
            const kind = Node.isArrowFunction(init) || Node.isFunctionExpression(init) ? 'function' : 'variable';
            yield { kind, nameNode, declaration: decl, exported: statement.isExported() };
        }
    }
    for (const cls of sourceFile.getClasses()) {
        const nameNode = cls.getNameNode();
        if (nameNode) yield { kind: 'class', nameNode, declaration: cls, exported: cls.isExported() };
    }
    for (const iface of sourceFile.getInterfaces()) yield { kind: 'interface', nameNode: iface.getNameNode(), declaration: iface, exported: iface.isExported() };
    for (const alias of sourceFile.getTypeAliases()) yield { kind: 'type', nameNode: alias.getNameNode(), declaration: alias, exported: alias.isExported() };
    for (const decl of sourceFile.getEnums()) yield { kind: 'enum', nameNode: decl.getNameNode(), declaration: decl, exported: decl.isExported() };
}

// a recursive call or a type naming itself doesn't make a binding used
function isWithin(node: Node, outer: Node): boolean {
    return node.getSourceFile() === outer.getSourceFile() && node.getStart() >= outer.getStart() && node.getEnd() <= outer.getEnd();
}

interface Result {
    kind: string;
    file: string;
    line: number;
    name: string;
    exported: boolean;
    testRefs: number;
    firstTestAt: string;
}

function reportResults(results: Result[]): void {
    results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    for (const r of results) {
        const detail = r.testRefs === 0 ? 'unused' : `only used in tests (${r.testRefs}x, first at ${r.firstTestAt}) — evaluate if this should stay`;
        console.log(`${r.file}:${r.line}  ${r.name}  (${r.kind})  ${detail}${r.exported ? '  [exported]' : ''}`);
    }
    const unused = results.filter(r => r.testRefs === 0).length;
    console.log(`\n${results.length} candidate(s): ${unused} unused, ${results.length - unused} only used in tests`);
}

const deadCode: Command = {
    name: 'dead-code',
    summary: 'top-level bindings nothing but tests use, or nothing at all',
    flags: [INCLUDE_EXPORTED_FLAG, LANG_FLAG],
    help: `
Flags top-level functions, consts/variables, classes, interfaces, type aliases
and enums that no production code references:

  - unused           no reference at all
  - only used in tests   referenced only from test files — the code exists to be
                     tested; evaluate if this should stay

Output:
  file:line  name  (kind)  unused                                          [exported]
  file:line  name  (kind)  only used in tests (Nx, first at file:line) — evaluate if this should stay

A reference inside the binding's own declaration (recursion, a type naming
itself) doesn't count, and neither does a Go method naming its own receiver
type. Code reachable only from other dead code is not followed: delete a hit and
re-run to see what it was keeping alive. Exported bindings are skipped unless
--include-exported, since their callers may live outside the scanned paths.

  --lang=ts  default, auto-detected from the path (a go.mod makes it go). Test
             files are *.test.*, *.spec.* and anything under __tests__/ next to
             the tsconfig; they are loaded into the project for this check even
             when the tsconfig leaves them out. Reflection, string-based lookups
             and framework entry points (routes, decorators, config files) are
             invisible — a hit is a place to look, not a verdict.
  --lang=go  path is a dir walked for *.go; runs go-analyzer/main.go (go/ast,
             stdlib only) via \`go run\`. Test files are *_test.go. Same-package
             references are matched by identifier name, so a local variable
             shadowing a top-level name hides a dead one. An exported name is
             looked up through the imports of every scanned file, resolved with
             the nearest go.mod — scan the module root to see all its callers.
             Skipped: methods (an interface may call them), \`main\`, \`init\`,
             funcs carrying //export or //go:linkname, and members of an iota
             const group.`,

    createGo(options: Options) {
        const results: Result[] = [];
        return {
            visit(filePaths: string[]) {
                for (const c of analyzeGoDeadCode(filePaths)) {
                    if (c.exported && !options.includeExported) continue;
                    const firstTestAt = c.testFile ? `${c.testFile}:${c.testLine}` : '';
                    results.push({ kind: c.kind === 'func' ? 'function' : c.kind, file: c.file, line: c.line, name: c.name, exported: c.exported, testRefs: c.testRefs, firstTestAt });
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
            visit(context) {
                withTestFiles(context, () => {
                    for (const sourceFile of context.sourceFiles) {
                        if (isTestFile(sourceFile.getFilePath())) continue;
                        for (const c of candidatesInFile(sourceFile)) {
                            if (c.exported && !options.includeExported) continue;
                            const refs = c.nameNode.findReferencesAsNodes().filter(ref => !isWithin(ref, c.declaration));
                            const testRefs = refs.filter(ref => isTestFile(ref.getSourceFile().getFilePath()));
                            if (testRefs.length < refs.length) continue;
                            const first = testRefs[0];
                            results.push({
                                kind: c.kind,
                                file: sourceFile.getFilePath(),
                                line: c.nameNode.getStartLineNumber(),
                                name: c.nameNode.getText(),
                                exported: c.exported,
                                testRefs: testRefs.length,
                                firstTestAt: first ? `${first.getSourceFile().getFilePath()}:${first.getStartLineNumber()}` : '',
                            });
                        }
                    }
                });
            },
            report() {
                reportResults(results);
            },
        };
    },
};

export default deadCode;
