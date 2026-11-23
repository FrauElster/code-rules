import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Project, ts } from 'ts-morph';
import type { ProjectContext } from './types.ts';

const EXCLUDE_PATH_PARTS = ['/node_modules/', '/.types/', '/dist/', '/schema/', 'plugin-map.ts', '.generated.', '.test.', '.spec.', '.d.ts'];
const EXCLUDE_DIR_NAMES = new Set(['node_modules', '.types', 'dist', '.git']);

const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$|\/__tests__\//;

export function isTestFile(filePath: string): boolean {
    return TEST_FILE_PATTERN.test(filePath);
}

// solution-style tsconfigs (bare `references`, `files: []`) aren't runnable projects — skip them
function isProjectTsConfig(filePath: string): boolean {
    const { config } = ts.parseConfigFileTextToJson(filePath, readFileSync(filePath, 'utf8'));
    if (!config) return false;
    return (Array.isArray(config.include) && config.include.length > 0) || (Array.isArray(config.files) && config.files.length > 0);
}

function findTsConfigsRecursive(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
            found.push(...findTsConfigsRecursive(fullPath));
        } else if (entry.isFile() && /^tsconfig(\..+)?\.json$/.test(entry.name)) {
            if (isProjectTsConfig(fullPath)) found.push(fullPath);
        }
    }
    return found;
}

export function resolveTsConfigs(paths: string[]): string[] {
    const resolved: string[] = [];
    for (const path of paths) {
        if (!existsSync(path)) throw new Error(`path not found: ${path}`);
        if (statSync(path).isDirectory()) {
            const found = findTsConfigsRecursive(path);
            if (found.length === 0) throw new Error(`no project tsconfigs found under: ${path}`);
            resolved.push(...found);
        } else {
            resolved.push(path);
        }
    }
    const unique = [...new Set(resolved)];
    if (unique.length > paths.length) console.error(`resolved to ${unique.length} project tsconfig(s):\n${unique.map(p => `  ${p}`).join('\n')}\n`);
    return unique;
}

// one ts-morph Project per tsconfig — workspaces import each other's *built* d.ts, not source, so a
// symbol never spans two tsconfigs; per-tsconfig reference search is the correct scope
export function* eachProject(tsConfigFilePaths: string[]): Generator<ProjectContext> {
    for (const tsConfigFilePath of tsConfigFilePaths) {
        const project = new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: false });
        const sourceFiles = project.getSourceFiles().filter(sf => !EXCLUDE_PATH_PARTS.some(p => sf.getFilePath().includes(p)));
        yield { tsConfigFilePath, project, sourceFiles };
    }
}

// eachProject leaves test files out of sourceFiles, and a tsconfig often leaves them out of the project
// altogether — a check that needs to see who calls what from tests loads them for the duration of `run`
// and unloads them again, so the other checks sharing this Project see exactly what they did before
export function withTestFiles<T>({ tsConfigFilePath, project }: ProjectContext, run: () => T): T {
    const loaded = new Set(project.getSourceFiles().map(sf => sf.getFilePath()));
    const root = dirname(resolve(tsConfigFilePath));
    const extensions = '{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
    const added = project
        .addSourceFilesAtPaths([`${root}/**/*.{test,spec}.${extensions}`, `${root}/**/__tests__/**/*.${extensions}`, `!${root}/**/node_modules/**`, `!${root}/**/dist/**`])
        .filter(sf => !loaded.has(sf.getFilePath()));
    try {
        return run();
    } finally {
        for (const sf of added) project.removeSourceFile(sf);
    }
}
