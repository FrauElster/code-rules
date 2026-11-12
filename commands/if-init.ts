import { LANG_FLAG, SCOPE_FLAG } from '../lib/args.ts';
import { addedLines } from '../lib/git.ts';
import { analyzeGoIfInit, type GoIfInitCandidate } from '../lib/go-analyzer.ts';
import type { Command, Options } from '../lib/types.ts';

const ifInit: Command = {
    name: 'if-init',
    summary: 'Go `if` statements with a long or multi-line init statement',
    flags: [SCOPE_FLAG, LANG_FLAG, { flag: '--max-length=N', key: 'maxLength', kind: 'number', default: 40, desc: 'longest single-line init statement left alone, in characters' }],
    help: `
Go only. Flags an \`if\` whose init statement is long or spans several lines:

  if result, err := s.repo.FindByID(ctx, customerID); err != nil {   // flagged
  if err := f(); err != nil {                                          // fine

The fix is declaring on the line before and keeping the \`if\` to its condition:

  result, err := s.repo.FindByID(ctx, customerID)
  if err != nil {

  --scope=uncommitted  only inits overlapping a line added/modified since HEAD
  --scope=all          every if statement in the given files
  --max-length=N       a one-line init up to N characters is not reported;
                       a multi-line one always is

Output:
  file:line  (N chars)  init statement
  file:line-endLine  (Nl)  first line of the init statement …`,

    createGo(options: Options) {
        const results: GoIfInitCandidate[] = [];
        const checkAll = options.scope === 'all';
        const maxLength = options.maxLength as number;
        return {
            visit(filePaths: string[]) {
                const addedByFile = new Map<string, Set<number> | null>();
                for (const candidate of analyzeGoIfInit(filePaths)) {
                    if (candidate.endLine === candidate.line && candidate.text.length <= maxLength) continue;
                    if (!checkAll) {
                        if (!addedByFile.has(candidate.file)) addedByFile.set(candidate.file, addedLines(candidate.file));
                        const added = addedByFile.get(candidate.file);
                        let overlapsAdded = false;
                        for (let line = candidate.line; line <= candidate.endLine; line++) {
                            if (added?.has(line)) {
                                overlapsAdded = true;
                                break;
                            }
                        }
                        if (!overlapsAdded) continue;
                    }
                    results.push(candidate);
                }
            },
            report() {
                results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
                console.log(`long/multi-line if init statements in ${checkAll ? 'the whole project' : 'uncommitted lines'}:`);
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
