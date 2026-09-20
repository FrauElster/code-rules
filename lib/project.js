import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Project, ts } from 'ts-morph';

const EXCLUDE_PATH_PARTS = ['/node_modules/', '/.types/', '/dist/', '/schema/', 'plugin-map.ts', '.generated.', '.test.', '.spec.', '.d.ts'];
const EXCLUDE_DIR_NAMES = new Set(['node_modules', '.types', 'dist', '.git']);

// solution-style tsconfigs (bare `references`, `files: []`) aren't runnable projects — skip them
function isProjectTsConfig(filePath) {
    const { config } = ts.parseConfigFileTextToJson(filePath, readFileSync(filePath, 'utf8'));
    if (!config) return false;
    return (Array.isArray(config.include) && config.include.length > 0) || (Array.isArray(config.files) && config.files.length > 0);
}

function findTsConfigsRecursive(dir) {
    const found = [];
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

export function resolveTsConfigs(paths) {
    const resolved = [];
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
export function* eachProject(tsConfigFilePaths) {
    for (const tsConfigFilePath of tsConfigFilePaths) {
        const project = new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: false });
        const sourceFiles = project.getSourceFiles().filter(sf => !EXCLUDE_PATH_PARTS.some(p => sf.getFilePath().includes(p)));
        yield { tsConfigFilePath, project, sourceFiles };
    }
}
