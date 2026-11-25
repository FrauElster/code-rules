import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FlagValue } from './types.ts';

export interface Hunk {
    // first line of the hunk in the current file, for a pure deletion the line the removed text sat before
    start: number;
    count: number;
    removed: string[];
}

// `--scope=uncommitted` diffs against HEAD, any other value but `all` is the revision to diff against; the working
// tree is the newer side either way, so in-flight edits count too
function diffBase(scope: FlagValue | undefined): string {
    return scope === undefined || scope === 'uncommitted' ? 'HEAD' : String(scope);
}

export function scopeLabel(scope: FlagValue | undefined): string {
    if (scope === 'all') return 'the whole project';
    if (scope === undefined || scope === 'uncommitted') return 'uncommitted lines';
    return `lines changed since ${scope}`;
}

// a mistyped revision would make every file look unchanged and every check report nothing
export function verifyRevision(scope: FlagValue | undefined, paths: string[]): string | null {
    if (scope === undefined || scope === 'all' || scope === 'uncommitted') return null;
    for (const path of paths) {
        try {
            execFileSync('git', ['rev-parse', '--verify', '--quiet', `${scope}^{commit}`], { cwd: existsSync(path) && statSync(path).isDirectory() ? path : dirname(path), stdio: 'ignore' });
        } catch {
            return `--scope=${scope}: not a revision in the repository of ${path}`;
        }
    }
    return null;
}

// hunks of the file's diff against the scope's base, an untracked file as one hunk of added lines
export function diffHunks(path: string, scope: FlagValue | undefined): Hunk[] | null {
    // git runs in the file's directory, a relative path would be resolved against it a second time
    const filePath = resolve(path);
    const cwd = dirname(filePath);
    let status: string;
    try {
        status = execFileSync('git', ['status', '--porcelain', '--', filePath], { cwd, encoding: 'utf8' });
    } catch {
        return null;
    }
    if (status.startsWith('??')) return [{ start: 1, count: readFileSync(filePath, 'utf8').split('\n').length, removed: [] }];
    let diff: string;
    try {
        diff = execFileSync('git', ['diff', '--no-color', '-U0', diffBase(scope), '--', filePath], { cwd, encoding: 'utf8' });
    } catch {
        return null;
    }
    const hunks: Hunk[] = [];
    for (const line of diff.split('\n')) {
        const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (header) {
            const count = header[2] === undefined ? 1 : Number(header[2]);
            // git numbers a pure deletion by the line before it
            hunks.push({ start: Number(header[1]) + (count === 0 ? 1 : 0), count, removed: [] });
        } else if (line.startsWith('-') && !line.startsWith('---')) hunks.at(-1)?.removed.push(line.slice(1));
    }
    return hunks;
}

// lines added/modified since the scope's base (staged + unstaged) — untracked files count as fully added
export function addedLines(filePath: string, scope: FlagValue | undefined): Set<number> | null {
    const hunks = diffHunks(filePath, scope);
    if (!hunks) return null;
    const added = new Set<number>();
    for (const hunk of hunks) for (let offset = 0; offset < hunk.count; offset++) added.add(hunk.start + offset);
    return added;
}

export function touchesAdded(added: Set<number> | null | undefined, line: number, endLine: number): boolean {
    for (let current = line; current <= endLine; current++) if (added?.has(current)) return true;
    return false;
}
