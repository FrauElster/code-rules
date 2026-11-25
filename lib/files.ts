import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const EXCLUDE_DIR_NAMES = new Set(['node_modules', '.git', 'vendor']);

// every file with the extension under dir, skipping node_modules/.git/vendor and dot entries
export function findFilesRecursive(dir: string, extension: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
            found.push(...findFilesRecursive(fullPath, extension));
        } else if (entry.isFile() && extname(entry.name) === extension) {
            found.push(fullPath);
        }
    }
    return found;
}
