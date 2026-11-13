import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// lines added/modified since HEAD (staged + unstaged) — untracked files count as fully added
export function addedLines(filePath: string): Set<number> | null {
    const cwd = dirname(filePath);
    let status: string;
    try {
        status = execFileSync('git', ['status', '--porcelain', '--', filePath], { cwd, encoding: 'utf8' });
    } catch {
        return null;
    }
    if (status.startsWith('??')) {
        const lineCount = readFileSync(filePath, 'utf8').split('\n').length;
        return new Set(Array.from({ length: lineCount }, (_, i) => i + 1));
    }
    let diff: string;
    try {
        diff = execFileSync('git', ['diff', '--no-color', '-U0', 'HEAD', '--', filePath], { cwd, encoding: 'utf8' });
    } catch {
        return null;
    }
    const added = new Set<number>();
    for (const line of diff.split('\n')) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!hunk) continue;
        const start = Number(hunk[1]);
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        for (let i = 0; i < count; i++) added.add(start + i);
    }
    return added;
}

export function touchesAdded(added: Set<number> | null | undefined, line: number, endLine: number): boolean {
    for (let current = line; current <= endLine; current++) if (added?.has(current)) return true;
    return false;
}
