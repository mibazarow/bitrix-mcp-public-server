export declare const resourceDefinitions: {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
}[];
export declare function handleResourceRead(uri: string): {
    contents: {
        uri: string;
        mimeType: string;
        text: string;
    }[];
};
