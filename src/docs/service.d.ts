export declare function ensureDocsDir(): void;
export declare function getDocTree(dir?: string): any[];
export declare function getDocContent(relPath: string): string | null;
export declare function getDocChunks(): {
    filePath: string;
    content: string;
}[];
export declare function listMdFiles(dir?: string): string[];
