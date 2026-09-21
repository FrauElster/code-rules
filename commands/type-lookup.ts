import { type Node, SyntaxKind, ts } from 'ts-morph';
import { SCOPE_FLAG } from '../lib/args.ts';
import { addedLines } from '../lib/git.ts';
import type { Command, Options } from '../lib/types.ts';

const WRITABLE_INTRINSIC =
    ts.TypeFlags.String |
    ts.TypeFlags.Number |
    ts.TypeFlags.Boolean |
    ts.TypeFlags.BigInt |
    ts.TypeFlags.ESSymbol |
    ts.TypeFlags.Void |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Never;

const NAMED_DECLARATION_KINDS = new Set([ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.EnumDeclaration]);

// a generic instantiation (`Foo[]`, symbol `Array`) carries its own type arguments — `TypeReference` is
// the compiler's node for one, so a plain `Type` reaching this point never has this shape by accident
function isGenericInstantiation(type: ts.Type): boolean {
    return (type.flags & ts.TypeFlags.Object) !== 0 && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0 && (type as ts.TypeReference).typeArguments !== undefined;
}

function namedSymbol(checker: ts.TypeChecker, type: ts.Type, node: Node): ts.Symbol | null {
    const symbol = type.aliasSymbol ?? type.symbol;
    if (!symbol || symbol.name.startsWith('__')) return null;
    const declarations = (symbol.declarations ?? []).filter(d => NAMED_DECLARATION_KINDS.has(d.kind));
    if (declarations.length === 0) return null;
    // a generic instantiation needs its type arguments back (`Foo[]` has symbol `Array`), so the bare name isn't it
    if (type.aliasTypeArguments?.length || isGenericInstantiation(type)) return null;
    if (checker.typeToString(type) !== symbol.name) return null;
    // the alias's own right-hand side — `type SearchPath = paths[keyof paths]` would be substituted with itself
    if (declarations.some(d => d.getSourceFile() === node.compilerNode.getSourceFile() && d.pos <= node.compilerNode.pos && node.compilerNode.end <= d.end)) return null;
    return symbol;
}

// does writing the bare name at this position mean the same thing — i.e. is the symbol in scope and unshadowed?
function inScope(checker: ts.TypeChecker, node: Node, symbol: ts.Symbol): boolean {
    let resolved: ts.Symbol | undefined;
    try {
        resolved = checker.resolveName(symbol.name, node.compilerNode, ts.SymbolFlags.Type, false);
    } catch {
        return false;
    }
    if (!resolved) return false;
    if (resolved === symbol) return true;
    const aliased = resolved.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(resolved) : null;
    return aliased === symbol;
}

function declaringFile(symbol: ts.Symbol): string | null {
    const declaration = (symbol.declarations ?? []).find(d => NAMED_DECLARATION_KINDS.has(d.kind));
    return declaration ? declaration.getSourceFile().fileName : null;
}

interface LookupResult {
    file: string;
    line: number;
    kind: 'named' | 'builtin';
    from: string;
    name: string;
    note: string;
}

const typeLookup: Command = {
    name: 'type-lookup',
    summary: 'indexed-access types (`Car["engine"]`) that resolve to a type you could name directly',
    flags: [
        SCOPE_FLAG,
        { flag: '--lookup-kind=all|named|builtin', key: 'lookupKind', kind: 'enum', values: ['all', 'named', 'builtin'], default: 'all', desc: 'which category to report' },
        { flag: '--out-of-scope', key: 'outOfScope', kind: 'boolean', default: false, desc: 'also report names that would need a new import' },
    ],
    help: `
Flags \`Car["steeringWheel"]\` where the property's type is already a type you
can write by name — \`SteeringWheel\` — so the lookup is indirection, not
information. Categories:

  named    resolves to a type alias / interface / class / enum
  builtin  resolves to an intrinsic (\`Car["name"]\` -> \`string\`)

Output:
  file:line  kind  Car["steeringWheel"] -> SteeringWheel

Never reported (the lookup is the only way to say it, or the name isn't one):
  - a property typed with an inline object literal — the type has no name
  - a generic instantiation, where the name alone drops the type arguments
    (\`Foo[]\` is the \`Array\` symbol; writing \`Array\` is not the same type)
  - a lookup inside the declaration of the very alias it resolves to
  - an optional property, or anything else resolving to a union/intersection
  - \`T["engine"]\` inside a generic, where the access is still deferred
  - a name that isn't in scope at that position, unless --out-of-scope; those
    print the declaring file, since acting on them means adding an import

A hit is a candidate, not a verdict: a lookup is deliberate when the point is
to *track* the other type — a signature that should follow \`Car\` if its
property type changes later is a reason to keep it.`,

    create(options: Options) {
        const results: LookupResult[] = [];
        const checkAll = options.scope === 'all';
        return {
            visit({ project, sourceFiles }) {
                const checker = project.getTypeChecker().compilerObject;
                for (const sourceFile of sourceFiles) {
                    const filePath = sourceFile.getFilePath();
                    const nodes = sourceFile.getDescendantsOfKind(SyntaxKind.IndexedAccessType);
                    if (nodes.length === 0) continue;

                    const added = checkAll ? null : addedLines(filePath);
                    if (!checkAll && (added === null || added.size === 0)) continue;

                    for (const node of nodes) {
                        const line = node.getStartLineNumber();
                        if (!checkAll && !added?.has(line)) continue;

                        let type: ts.Type;
                        try {
                            type = checker.getTypeFromTypeNode(node.compilerNode);
                        } catch {
                            continue;
                        }
                        if (type.flags & (ts.TypeFlags.IndexedAccess | ts.TypeFlags.TypeParameter | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) continue;

                        const symbol = namedSymbol(checker, type, node);
                        let kind: 'named' | 'builtin';
                        let name: string;
                        let note = '';
                        if (symbol) {
                            kind = 'named';
                            name = symbol.name;
                            if (!inScope(checker, node, symbol)) {
                                if (!options.outOfScope) continue;
                                note = `  (import from ${declaringFile(symbol) ?? '?'})`;
                            }
                        } else if (type.flags & WRITABLE_INTRINSIC) {
                            kind = 'builtin';
                            name = checker.typeToString(type);
                        } else continue;

                        if (options.lookupKind !== 'all' && kind !== options.lookupKind) continue;
                        results.push({ file: filePath, line, kind, from: node.getText(), name, note });
                    }
                }
            },
            report() {
                results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
                const width = Math.max(0, ...results.map(r => r.kind.length));
                for (const r of results) console.log(`${r.file}:${r.line}  ${r.kind.padEnd(width)}  ${r.from} -> ${r.name}${r.note}`);
                console.log(`\n${results.length} candidate(s)`);
            },
        };
    },
};

export default typeLookup;
