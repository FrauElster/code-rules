import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const EXCLUDE_DIR_NAMES = new Set(['node_modules', '.git', 'vendor']);

// go generate / protoc / mockgen etc. all emit this exact header line near the top of the file —
// never hand-written, so never worth a style check
function isGeneratedGoFile(text: string): boolean {
    return /^\/\/ Code generated .* DO NOT EDIT\.$/m.test(text.slice(0, 500));
}

function findGoFilesRecursive(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
            found.push(...findGoFilesRecursive(fullPath));
        } else if (entry.isFile() && extname(entry.name) === '.go') {
            found.push(fullPath);
        }
    }
    return found;
}

// paths are directories (walked recursively for *.go, skipping node_modules/.git/vendor) or individual .go files
export function resolveGoFiles(paths: string[]): string[] {
    const resolved: string[] = [];
    for (const path of paths) {
        if (!existsSync(path)) throw new Error(`path not found: ${path}`);
        if (statSync(path).isDirectory()) {
            const found = findGoFilesRecursive(path);
            if (found.length === 0) throw new Error(`no .go files found under: ${path}`);
            resolved.push(...found);
        } else {
            resolved.push(path);
        }
    }
    const unique = [...new Set(resolved)];
    return unique.filter(f => {
        try {
            return !isGeneratedGoFile(readFileSync(f, 'utf8'));
        } catch {
            return true;
        }
    });
}
