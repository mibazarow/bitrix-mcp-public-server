export declare const toolDefinitions: ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            moduleId?: undefined;
            cursor?: undefined;
            functionName?: undefined;
            strictSearch?: undefined;
            returnCode?: undefined;
            namespace?: undefined;
        };
        required: never[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            moduleId: {
                type: string;
            };
            cursor: {
                type: string;
            };
            functionName?: undefined;
            strictSearch?: undefined;
            returnCode?: undefined;
            namespace?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            moduleId: {
                type: string;
            };
            cursor?: undefined;
            functionName?: undefined;
            strictSearch?: undefined;
            returnCode?: undefined;
            namespace?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            functionName: {
                type: string;
            };
            moduleId: {
                type: string;
            };
            strictSearch: {
                type: string;
            };
            cursor?: undefined;
            returnCode?: undefined;
            namespace?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            functionName: {
                type: string;
            };
            moduleId: {
                type: string;
            };
            cursor?: undefined;
            strictSearch?: undefined;
            returnCode?: undefined;
            namespace?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            functionName: {
                type: string;
            };
            returnCode: {
                type: string;
            };
            moduleId?: undefined;
            cursor?: undefined;
            strictSearch?: undefined;
            namespace?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            namespace: {
                type: string;
            };
            moduleId?: undefined;
            cursor?: undefined;
            functionName?: undefined;
            strictSearch?: undefined;
            returnCode?: undefined;
        };
        required: string[];
    };
})[];
export declare function handleToolCall(name: string, args: Record<string, any>): Promise<any>;
