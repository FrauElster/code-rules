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

// the project's own Go lint when a Taskfile (found upward from dir, as task itself searches) has one: `lint:go`
// over `lint`, which in a mixed repo also lints the other languages
function goLintTask(dir: string): { task: string; taskfile: string } | null {
    const listing = runTool('task', ['--list-all', '--json'], dir);
    if (listing.status !== 0) return null;
    let parsed: { location?: string; tasks?: { name: string }[] };
    try {
        parsed = JSON.parse(listing.output);
    } catch {
        return null;
    }
    const names = new Set(parsed.tasks?.map(task => task.name));
    const task = ['lint:go', 'lint'].find(name => names.has(name));
    return task && parsed.location ? { task, taskfile: parsed.location } : null;
}

// gofmt -l exits 0 whether or not it lists files, and none of go vet, go fix or a typical lint task checks formatting
function gofmtRun(dir: string): ToolRun {
    const run = runTool('gofmt', ['-l', '.'], dir);
    return run.status === 0 && run.output !== '' ? { ...run, status: 1, output: `not gofmt-formatted (gofmt -w):\n${run.output}` } : run;
}

function goRuns(dir: string, tasks: Set<string>): ToolRun[] {
    const runs = [gofmtRun(dir)];
    const task = goLintTask(dir);
    if (!task) return [...runs, runTool('go', ['vet', './...'], dir), runTool('go', ['fix', '-diff', './...'], dir)];
    const key = `${task.taskfile} ${task.task}`;
    if (tasks.has(key)) return runs;
    tasks.add(key);
    return [...runs, runTool('task', [task.task], dir)];
}

const lint: Command = {
    name: 'lint',
    summary: "run the project's own tooling (`pnpm lint`, a Taskfile's Go lint or `go vet` + `go fix -diff`, `gofmt -l`) and flag failures",
    flags: [LANG_FLAG],
    help: `
TypeScript: runs \`pnpm lint\` in the nearest directory above each tsconfig whose
package.json has a \`lint\` script. Go, in the nearest directory above each .go
file with a go.mod:
  - \`gofmt -l .\`, failing when it lists a file (fix with \`gofmt -w\`)
  - the project's own lint: \`task lint:go\`, else \`task lint\`, when \`task\` is on
    PATH and a Taskfile above the module has one (run once per Taskfile)
  - otherwise \`go vet ./...\` and \`go fix -diff ./...\` — the latter only prints
    the patch and fails when there is one; apply it with \`go fix ./...\`
Nothing is rewritten: a lint task that rewrites files is the project's choice.

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
        const tasks = new Set<string>();
        return {
            visit(paths: string[]) {
                const dirs = new Set<string>();
                for (const path of paths) {
                    const dir = isGo ? nearestDir(dirname(path), candidate => existsSync(join(candidate, 'go.mod'))) : nearestDir(dirname(path), hasLintScript);
                    if (dir) dirs.add(dir);
                    else missing.add(dirname(path));
                }
                for (const dir of dirs) runs.push(...(isGo ? goRuns(dir, tasks) : [runTool('pnpm', ['lint'], dir)]));
            },
            report() {
                reportToolRuns(runs, missing, isGo ? 'go.mod' : 'package.json with a lint script');
            },
        };
    },
};

export default lint;
