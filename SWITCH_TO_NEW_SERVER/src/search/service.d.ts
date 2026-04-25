export declare function indexAllDocs(onProgress?: (current: number, total: number) => void): Promise<void>;
export declare function searchDocs(query: string, limit?: number): Promise<any[]>;
