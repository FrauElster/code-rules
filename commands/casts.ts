import { Node, SyntaxKind, ts } from 'ts-morph';
import { SCOPE_FLAG } from '../lib/args.ts';
import { addedLines } from '../lib/git.ts';
import type { Command, Options } from '../lib/types.ts';

const LITERAL_EXPRESSION_KINDS = [SyntaxKind.ObjectLiteralExpression, SyntaxKind.ArrayLiteralExpression];

function unwrapParens(node: Node): Node {
    let current = node;
    while (Node.isParenthesizedExpression(current)) current = current.getExpression();
    return current;
}

function assertionParts(node: Node): { expression: Node; typeNode: Node | undefined } | null {
    if (Node.isAsExpression(node) || Node.isTypeAssertion(node)) return { expression: node.getExpression(), typeNode: node.getTypeNode() };
    return null;
}

// `as const` is a literal-freshness directive, not a type assertion
function isAsConst(typeNode: Node): boolean {
    return typeNode.getKind() === SyntaxKind.TypeReference && typeNode.getText() === 'const';
}

function isKeyword(typeNode: Node, kind: SyntaxKind): boolean {
    return typeNode.getKind() === kind;
}

interface CastHit {
    kind: 'identical' | 'widening' | 'any' | 'unknown-chain';
    detail: string;
}

function classify(node: Node, expression: Node, typeNode: Node, checker: ts.TypeChecker, options: Options): CastHit | null {
    if (isKeyword(typeNode, SyntaxKind.AnyKeyword)) return { kind: 'any', detail: 'as any' };

    const inner = assertionParts(unwrapParens(expression));
    if (inner?.typeNode && isKeyword(inner.typeNode, SyntaxKind.UnknownKeyword)) return { kind: 'unknown-chain', detail: `as unknown as ${typeNode.getText()}` };
    if (isKeyword(typeNode, SyntaxKind.UnknownKeyword)) return null; // the inner half of a chain, or a deliberate widen to unknown

    const expr = unwrapParens(expression);
    if (!options.includeLiterals && LITERAL_EXPRESSION_KINDS.includes(expr.getKind())) return null;

    let sourceType: ts.Type;
    let targetType: ts.Type;
    try {
        sourceType = checker.getTypeAtLocation(expr.compilerNode);
        targetType = checker.getTypeAtLocation(typeNode.compilerNode);
    } catch {
        return null;
    }
    if (sourceType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null; // the cast is what gives the value a type
    if (!checker.isTypeAssignableTo(sourceType, targetType)) return null; // a genuine narrowing/reinterpreting cast

    const sourceText = checker.typeToString(sourceType, node.compilerNode);
    const targetText = checker.typeToString(targetType, node.compilerNode);
    if (sourceText === targetText) return { kind: 'identical', detail: `${sourceText} as ${targetText}` };
    return { kind: 'widening', detail: `${sourceText} as ${targetText}` };
}

interface CastResult extends CastHit {
    file: string;
    line: number;
}

const casts: Command = {
    name: 'casts',
    summary: 'type assertions that the type already satisfies (plus `as any` / `as unknown as`)',
    flags: [
        SCOPE_FLAG,
        {
            flag: '--cast-kind=all|identical|widening|any|unknown-chain',
            key: 'castKind',
            kind: 'enum',
            values: ['all', 'identical', 'widening', 'any', 'unknown-chain'],
            default: 'all',
            desc: 'which category to report',
        },
        { flag: '--include-literals', key: 'includeLiterals', kind: 'boolean', default: false, desc: 'also check casts on object/array literals (contextually typed — noisy)' },
    ],
    help: `
Flags \`x as T\` / \`<T>x\` assertions that don't do anything the type system
didn't already know, plus the two forms AGENTS.md bans outright. Categories:

  identical      source and target print as the same type — pure noise
  widening       source is already assignable to target (e.g. a literal type cast
                 to its widened form); removing it only changes inference
  any            \`as any\`
  unknown-chain  \`as unknown as T\` — AGENTS.md: restructure types instead

A cast that narrows or reinterprets (source *not* assignable to target) is the
legitimate use and is never reported, and neither is a cast on an \`any\`/\`unknown\`
source, where the cast is what supplies the type.

  --scope=uncommitted  only assertions on a line added/modified since HEAD
  --scope=all          the whole project
  --cast-kind=...      report one category instead of all four
  --include-literals   object/array literals are contextually typed by the
                       assertion itself, so they look assignable even when the
                       cast is load-bearing (excess-property checks, inference of
                       a union member); off by default for that reason

Output:
  file:line  kind  detail

\`as const\` is never an assertion in this sense and is always skipped.`,

    create(options: Options) {
        const results: CastResult[] = [];
        const checkAll = options.scope === 'all';
        return {
            visit({ project, sourceFiles }) {
                const checker = project.getTypeChecker().compilerObject;
                for (const sourceFile of sourceFiles) {
                    const filePath = sourceFile.getFilePath();
                    const nodes = [...sourceFile.getDescendantsOfKind(SyntaxKind.AsExpression), ...sourceFile.getDescendantsOfKind(SyntaxKind.TypeAssertionExpression)];
                    if (nodes.length === 0) continue;

                    const added = checkAll ? null : addedLines(filePath);
                    if (!checkAll && (added === null || added.size === 0)) continue;

                    for (const node of nodes) {
                        const parts = assertionParts(node);
                        if (!parts?.typeNode || isAsConst(parts.typeNode)) continue;
                        const line = node.getStartLineNumber();
                        if (!checkAll && !added?.has(line)) continue;
                        const hit = classify(node, parts.expression, parts.typeNode, checker, options);
                        if (!hit) continue;
                        if (options.castKind !== 'all' && hit.kind !== options.castKind) continue;
                        results.push({ file: filePath, line, ...hit });
                    }
                }
            },
            report() {
                results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
                const width = Math.max(0, ...results.map(r => r.kind.length));
                for (const r of results) console.log(`${r.file}:${r.line}  ${r.kind.padEnd(width)}  ${r.detail}`);
                console.log(`\n${results.length} candidate(s)`);
            },
        };
    },
};

export default casts;
