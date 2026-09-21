import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const EXCLUDE_DIR_NAMES = new Set(['node_modules', '.git', 'vendor', '.types', 'dist']);

function containsRecursive(dir: string, isMatch: (name: string) => boolean): boolean {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        if (entry.isDirectory()) {
            if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
            if (containsRecursive(join(dir, entry.name), isMatch)) return true;
        } else if (isMatch(entry.name)) {
            return true;
        }
    }
    return false;
}

const isTsConfigName = (name: string) => /^tsconfig(\..+)?\.json$/.test(name);

// a path is Go if it (or something under it) has a go.mod, TS if it (or something under it) has a
// tsconfig — go.mod wins on a path that somehow has both, since a Go module never has a tsconfig too
export function detectLang(paths: string[]): 'ts' | 'go' {
    for (const path of paths) {
        if (!existsSync(path)) continue;
        if (statSync(path).isFile()) {
            if (path.endsWith('.go')) return 'go';
            if (isTsConfigName(basename(path))) return 'ts';
            continue;
        }
        if (existsSync(join(path, 'go.mod')) || containsRecursive(path, name => name === 'go.mod')) return 'go';
        if (containsRecursive(path, isTsConfigName)) return 'ts';
    }
    return 'ts';
}
