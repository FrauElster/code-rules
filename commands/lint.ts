import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LANG_FLAG } from '../lib/args.ts';
import { nearestDir, reportToolRuns, runTool, type ToolRun } from '../lib/tool.ts';
import type { Command, Options } from '../lib/types.ts';

function hasLintScript(dir: string): boolean {
    const packageJson = join(dir, 'package.json');
    if (!existsSync(packageJson)) return false;
    try {
        return typeof JSON.parse(readFileSync(packageJson, 'utf8')).scripts?.lint === 'string';
    } catch {
        return false;
    }
}

const lint: Command = {
    name: 'lint',
    summary: "run the project's own tooling (`pnpm lint`, `go fix -diff`) and flag failures",
    flags: [LANG_FLAG],
    help: `
TypeScript: runs \`pnpm lint\` in the nearest directory above each tsconfig whose
package.json has a \`lint\` script. Go: runs \`go fix -diff ./...\` in the nearest
directory above each .go file with a go.mod — it only prints the patch and fails
when there is one, so nothing is rewritten; apply it with \`go fix ./...\`.

Always checks the whole project: tool output has no reliable line mapping to
narrow it to uncommitted lines.

Output:
  command  in dir  ok
  command  in dir  failed (exit N)
      tool output …`,

    createTool(options: Options) {
        const isGo = options.lang === 'go';
        const runs: ToolRun[] = [];
        const missing = new Set<string>();
        return {
            visit(paths: string[]) {
                const dirs = new Set<string>();
                for (const path of paths) {
                    const dir = isGo ? nearestDir(dirname(path), candidate => existsSync(join(candidate, 'go.mod'))) : nearestDir(dirname(path), hasLintScript);
                    if (dir) dirs.add(dir);
                    else missing.add(dirname(path));
                }
                for (const dir of dirs) runs.push(isGo ? runTool('go', ['fix', '-diff', './...'], dir) : runTool('pnpm', ['lint'], dir));
            },
            report() {
                reportToolRuns(runs, missing, isGo ? 'go.mod' : 'package.json with a lint script');
            },
        };
    },
};

export default lint;
