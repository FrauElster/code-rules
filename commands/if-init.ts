import { LANG_FLAG, SCOPE_FLAG } from '../lib/args.ts';
import { addedLines, scopeLabel, touchesAdded } from '../lib/git.ts';
import { analyzeGoIfInit, type GoSpanCandidate } from '../lib/go-analyzer.ts';
import type { Command, Options } from '../lib/types.ts';

// `if err := f(x); err != nil` and `if _, err := …` are the Go idiom at any length: the line length is the formatter's
// business, and the err it declares is scoped to the if
function bindsOnlyErr(init: string): boolean {
    const lhs = /^([\w\s,]+?)\s*:?=[^=]/.exec(init)?.[1] ?? '';
    const names = lhs.split(',').map(name => name.trim());
    return names.includes('err') && names.every(name => name === 'err' || name === '_');
}

const ifInit: Command = {
    name: 'if-init',
    summary: 'Go `if` statements with a long or multi-line init statement',
    flags: [SCOPE_FLAG, LANG_FLAG, { flag: '--max-length=N', key: 'maxLength', kind: 'number', default: 40, desc: 'longest single-line init statement left alone, in characters' }],
    help: `
Go only. Flags an \`if\` whose init statement spans several lines, or is long and
declares more than \`err\`:

  if result, err := s.repo.FindByID(ctx, customerID); err != nil {   // flagged
  if err := f(); err != nil {                                          // fine
  if _, err := db.ExecContext(ctx, query, id); err != nil {            // fine

The fix is declaring on the line before and keeping the \`if\` to its condition:

  result, err := s.repo.FindByID(ctx, customerID)
  if err != nil {

  --scope=uncommitted  only inits overlapping a line added/modified since HEAD
  --scope=all          every if statement in the given files
  --max-length=N       a one-line init up to N characters is not reported;
                       a multi-line one always is, a one-line one that
                       declares only err (and _) never

Output:
  file:line  (N chars)  init statement
  file:line-endLine  (Nl)  first line of the init statement …`,

    createGo(options: Options) {
        const results: GoSpanCandidate[] = [];
        const checkAll = options.scope === 'all';
        const maxLength = options.maxLength as number;
        return {
            visit(filePaths: string[]) {
                const addedByFile = new Map<string, Set<number> | null>();
                for (const candidate of analyzeGoIfInit(filePaths)) {
                    if (candidate.endLine === candidate.line && (candidate.text.length <= maxLength || bindsOnlyErr(candidate.text))) continue;
                    if (!checkAll) {
                        if (!addedByFile.has(candidate.file)) addedByFile.set(candidate.file, addedLines(candidate.file, options.scope));
                        if (!touchesAdded(addedByFile.get(candidate.file), candidate.line, candidate.endLine)) continue;
                    }
                    results.push(candidate);
                }
            },
            report() {
                results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
                console.log(`long/multi-line if init statements in ${scopeLabel(options.scope)}:`);
                for (const hit of results) {
                    if (hit.endLine === hit.line) console.log(`${hit.file}:${hit.line}  (${hit.text.length} chars)  ${hit.text}`);
                    else console.log(`${hit.file}:${hit.line}-${hit.endLine}  (${hit.endLine - hit.line + 1}l)  ${hit.text.split('\n')[0]} …`);
                }
                console.log(`\n${results.length} candidate(s)`);
            },
        };
    },
};

export default ifInit;
