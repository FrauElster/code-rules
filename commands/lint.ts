import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { LANG_FLAG } from '../lib/args.ts';
import type { Command, Options } from '../lib/types.ts';

interface ToolRun {
    command: string;
    dir: string;
    status: number | null;
    output: string;
}

function nearestDir(start: string, isMatch: (dir: string) => boolean): string | null {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
        if (isMatch(dir)) return dir;
        if (dirname(dir) === dir) return null;
    }
}

function hasLintScript(dir: string): boolean {
    const packageJson = join(dir, 'package.json');
    if (!existsSync(packageJson)) return false;
    try {
        return typeof JSON.parse(readFileSync(packageJson, 'utf8')).scripts?.lint === 'string';
    } catch {
        return false;
    }
}

function runTool(program: string, args: string[], dir: string): ToolRun {
    const command = [program, ...args].join(' ');
    const result = spawnSync(program, args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error) {
        const missing = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
        return { command, dir, status: null, output: missing ? `\`${program}\` not found on PATH` : result.error.message };
    }
    return { command, dir, status: result.status, output: `${result.stdout}${result.stderr}`.trim() };
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
                const failed = runs.filter(run => run.status !== 0);
                for (const run of runs) {
                    console.log(`${run.command}  in ${run.dir}  ${run.status === 0 ? 'ok' : `failed${run.status === null ? '' : ` (exit ${run.status})`}`}`);
                    if (run.status !== 0 && run.output) console.log(run.output.replace(/^/gm, '    '));
                }
                if (missing.size > 0) {
                    console.log(`\nno ${isGo ? 'go.mod' : 'package.json with a lint script'} above:`);
                    for (const dir of missing) console.log(`  ${dir}`);
                }
                console.log(`\n${failed.length} failure(s)`);
            },
        };
    },
};

export default lint;
