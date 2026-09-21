import type { Project, SourceFile } from 'ts-morph';

export type FlagValue = boolean | number | string | string[];

export interface FlagSpec {
    flag: string;
    key: string;
    kind: 'boolean' | 'number' | 'enum' | 'list';
    values?: readonly string[];
    default?: FlagValue;
    desc: string;
}

export type Options = Record<string, FlagValue | undefined>;

export interface ProjectContext {
    tsConfigFilePath: string;
    project: Project;
    sourceFiles: SourceFile[];
}

export interface Runner<Input> {
    visit(input: Input): void;
    report(): void;
}

export interface Command {
    name: string;
    summary: string;
    flags: FlagSpec[];
    help?: string;
    members?: Command[];
    create?(options: Options): Runner<ProjectContext>;
    createGo?(options: Options): Runner<string[]>;
}
