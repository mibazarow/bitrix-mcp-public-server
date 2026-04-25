import Database from "better-sqlite3";
import type { ParsedFunction, ParsedClass } from "../utils/php-parser.js";
export declare function initDb(): void;
export declare function getDb(): Database.Database;
export declare function upsertModule(id: string, name: string, path: string, version?: string): void;
export declare function insertFunction(fn: ParsedFunction & {
    moduleId: string;
    filePath: string;
}): void;
export declare function insertClass(cls: ParsedClass & {
    moduleId: string;
    filePath: string;
}): void;
export declare function insertEvent(evt: ParsedEvent & {
    moduleId: string;
    filePath: string;
}): void;
export declare function clearModuleData(moduleId: string): void;
export declare function listModules(): {
    id: string;
    name: string;
    version: string;
}[];
export declare function getModuleFunctions(moduleId: string, limit: number, offset: number): {
    functions: any[];
    total: number;
};
export declare function getModuleEvents(moduleId: string): any[];
export declare function findFunction(name: string, moduleId?: string): any[];
export declare function findFunctionExact(name: string): any[];
export declare function findByNamespace(namespace: string): {
    classes: any[];
    functions: any[];
};
export declare function getClasses(moduleId: string, limit: number, offset: number): {
    classes: any[];
    total: number;
};
export declare function getFunctionCode(name: string, moduleId: string): string | null;
export declare function insertDocChunk(filePath: string, chunkIndex: number, content: string, embedding: Buffer | null): void;
export declare function clearDocChunks(): void;
export declare function searchDocChunks(queryEmbedding: Float32Array, limit?: number): any[];
