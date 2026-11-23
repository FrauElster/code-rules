import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

export interface ToolRun {
    command: string;
    dir: string;
    status: number | null;
    output: string;
}

export function nearestDir(start: string, isMatch: (dir: string) => boolean): string | null {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
        if (isMatch(dir)) return dir;
        if (dirname(dir) === dir) return null;
    }
}

export function runTool(program: string, args: string[], dir: string): ToolRun {
    const command = [program, ...args].join(' ');
    const result = spawnSync(program, args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error) {
        const missing = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
        return { command, dir, status: null, output: missing ? `\`${program}\` not found on PATH` : result.error.message };
    }
    return { command, dir, status: result.status, output: `${result.stdout}${result.stderr}`.trim() };
}

export function reportToolRuns(runs: ToolRun[], missing: Set<string>, missingLabel: string): void {
    const failed = runs.filter(run => run.status !== 0);
    for (const run of runs) {
        console.log(`${run.command}  in ${run.dir}  ${run.status === 0 ? 'ok' : `failed${run.status === null ? '' : ` (exit ${run.status})`}`}`);
        if (run.status !== 0 && run.output) console.log(run.output.replace(/^/gm, '    '));
    }
    if (missing.size > 0) {
        console.log(`\nno ${missingLabel} above:`);
        for (const dir of missing) console.log(`  ${dir}`);
    }
    console.log(`\n${failed.length} failure(s)`);
}
