import { existsSync, readFileSync, statSync } from 'node:fs';
import { findFilesRecursive } from './files.ts';

// go generate / protoc / mockgen etc. all emit this exact header line near the top of the file —
// never hand-written, so never worth a style check
function isGeneratedGoFile(text: string): boolean {
    return /^\/\/ Code generated .* DO NOT EDIT\.$/m.test(text.slice(0, 500));
}

// paths are directories (walked recursively for *.go, skipping node_modules/.git/vendor) or individual .go files
export function resolveGoFiles(paths: string[]): string[] {
    const resolved: string[] = [];
    for (const path of paths) {
        if (!existsSync(path)) throw new Error(`path not found: ${path}`);
        if (statSync(path).isDirectory()) {
            const found = findFilesRecursive(path, '.go');
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
