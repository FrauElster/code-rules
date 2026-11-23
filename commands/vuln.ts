import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LANG_FLAG } from '../lib/args.ts';
import { nearestDir, reportToolRuns, runTool, type ToolRun } from '../lib/tool.ts';
import type { Command, Options } from '../lib/types.ts';

const vuln: Command = {
    name: 'vuln',
    summary: 'run the dependency vulnerability scanners (`pnpm audit`, `govulncheck`) and flag findings',
    flags: [LANG_FLAG],
    help: `
TypeScript: runs \`pnpm audit\` in the nearest directory above each tsconfig that has
a pnpm-lock.yaml (the workspace root, for a monorepo). Go: runs \`govulncheck ./...\`
in the nearest directory above each .go file with a go.mod. Both exit non-zero when
they find a known vulnerability; govulncheck only reports ones the code actually calls.

Needs network access (both query a vulnerability database) and, for Go, \`govulncheck\`
on PATH (\`go install golang.org/x/vuln/cmd/govulncheck@latest\`). Always checks the
whole project, never rewrites anything.

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
                const marker = isGo ? 'go.mod' : 'pnpm-lock.yaml';
                const dirs = new Set<string>();
                for (const path of paths) {
                    const dir = nearestDir(dirname(path), candidate => existsSync(join(candidate, marker)));
                    if (dir) dirs.add(dir);
                    else missing.add(dirname(path));
                }
                for (const dir of dirs) runs.push(isGo ? runTool('govulncheck', ['./...'], dir) : runTool('pnpm', ['audit'], dir));
            },
            report() {
                reportToolRuns(runs, missing, isGo ? 'go.mod' : 'pnpm-lock.yaml');
            },
        };
    },
};

export default vuln;
