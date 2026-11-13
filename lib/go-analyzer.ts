import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN_GO = join(dirname(fileURLToPath(import.meta.url)), '..', 'go-analyzer', 'main.go');

export type GoInlineCandidate =
    | { kind: 'func'; file: string; line: number; name: string; bodyLines: number; exported: boolean }
    | { kind: 'const'; file: string; line: number; name: string; useCount: number; usedIn: string; usedInLine: number; exported: boolean };

export interface GoSpanCandidate {
    file: string;
    line: number;
    endLine: number;
    text: string;
}

// runs go-analyzer/main.go as a subprocess (`go run`, not a prebuilt binary — this tool has no
// build step) over the given absolute .go file paths and returns its JSON candidates. Requires the
// `go` toolchain on PATH; the analyzer itself needs no go.mod (stdlib-only) and does no network I/O.
function runGoAnalyzer(mode: 'inline' | 'if-init' | 'multi-assign', filePaths: string[]) {
    if (filePaths.length === 0) return [];
    const result = spawnSync('go', ['run', MAIN_GO, mode], { input: JSON.stringify(filePaths), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('go-analyzer: `go` toolchain not found on PATH — required for --lang=go on this command');
        throw result.error;
    }
    if (result.status !== 0) throw new Error(`go-analyzer: exited ${result.status}\n${result.stderr}`);
    if (result.stderr) process.stderr.write(result.stderr);
    return JSON.parse(result.stdout);
}

export function analyzeGoInline(filePaths: string[]): GoInlineCandidate[] {
    return runGoAnalyzer('inline', filePaths);
}

export function analyzeGoIfInit(filePaths: string[]): GoSpanCandidate[] {
    return runGoAnalyzer('if-init', filePaths);
}

export function analyzeGoMultiAssign(filePaths: string[]): GoSpanCandidate[] {
    return runGoAnalyzer('multi-assign', filePaths);
}
