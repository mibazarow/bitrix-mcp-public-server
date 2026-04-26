export interface IndexProgress {
    total: number;
    current: number;
    module: string;
    file: string;
}
export declare function indexAllModules(onProgress?: (p: IndexProgress) => void): {
    modulesIndexed: number;
    functionsIndexed: number;
};
export declare function hasChangesSince(date: Date): boolean;
