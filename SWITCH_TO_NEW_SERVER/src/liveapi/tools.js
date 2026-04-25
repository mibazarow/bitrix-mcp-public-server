import { listModules, getModuleFunctions, getModuleEvents, findFunction, findFunctionExact, getFunctionCode, findByNamespace, getClasses } from "./storage.js";
import { indexAllModules } from "./indexer.js";
import { execSync } from "child_process";
const PAGE_SIZE = 50;
export const toolDefinitions = [
    {
        name: "liveApiListModules",
        description: "List all installed Bitrix modules with versions",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "liveApiGetModuleFunctions",
        description: "Get functions of a module with cursor-based pagination",
        inputSchema: {
            type: "object",
            properties: {
                moduleId: { type: "string" },
                cursor: { type: "string" },
            },
            required: ["moduleId"],
        },
    },
    {
        name: "liveApiGetModuleClasses",
        description: "Get classes of a module with cursor-based pagination",
        inputSchema: {
            type: "object",
            properties: {
                moduleId: { type: "string" },
                cursor: { type: "string" },
            },
            required: ["moduleId"],
        },
    },
    {
        name: "liveApiGetModuleEvents",
        description: "Get all events registered in a module",
        inputSchema: {
            type: "object",
            properties: { moduleId: { type: "string" } },
            required: ["moduleId"],
        },
    },
    {
        name: "liveApiFindFunction",
        description: "Search for a function/method by name across all modules",
        inputSchema: {
            type: "object",
            properties: {
                functionName: { type: "string" },
                moduleId: { type: "string" },
                strictSearch: { type: "boolean" },
            },
            required: ["functionName"],
        },
    },
    {
        name: "liveApiGetFunctionCode",
        description: "Get the full source code of a function with PHPDoc",
        inputSchema: {
            type: "object",
            properties: {
                functionName: { type: "string" },
                moduleId: { type: "string" },
            },
            required: ["functionName", "moduleId"],
        },
    },
    {
        name: "liveApiFindByReflection",
        description: "Search across all code by name with optional code return",
        inputSchema: {
            type: "object",
            properties: {
                functionName: { type: "string" },
                returnCode: { type: "boolean" },
            },
            required: ["functionName"],
        },
    },
    {
        name: "liveApiFindByNamespace",
        description: "Find all classes and functions belonging to a PHP namespace (e.g. Bitrix\\Main\\IO)",
        inputSchema: {
            type: "object",
            properties: {
                namespace: { type: "string" },
            },
            required: ["namespace"],
        },
    },
    {
        name: "envInfo",
        description: "Get environment info: OS, PHP version, Bitrix modules, memory",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "liveApiReindex",
        description: "Force reindex all PHP functions from Bitrix modules",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
];
export async function handleToolCall(name, args) {
    switch (name) {
        case "liveApiListModules":
            return { content: [{ type: "text", text: JSON.stringify(listModules(), null, 2) }] };
        case "liveApiGetModuleFunctions": {
            const { moduleId, cursor } = args;
            const offset = cursor ? parseInt(cursor, 10) : 0;
            const result = getModuleFunctions(moduleId, PAGE_SIZE, offset);
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            id: moduleId,
                            functions: result.functions,
                            nextCursor: offset + PAGE_SIZE < result.total ? String(offset + PAGE_SIZE) : undefined,
                        }, null, 2),
                    }],
            };
        }
        case "liveApiGetModuleClasses": {
            const { moduleId, cursor } = args;
            const offset = cursor ? parseInt(cursor, 10) : 0;
            const result = getClasses(moduleId, PAGE_SIZE, offset);
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({
                            id: moduleId,
                            classes: result.classes,
                            nextCursor: offset + PAGE_SIZE < result.total ? String(offset + PAGE_SIZE) : undefined,
                        }, null, 2),
                    }],
            };
        }
        case "liveApiGetModuleEvents": {
            const events = getModuleEvents(args.moduleId);
            return {
                content: [{ type: "text", text: JSON.stringify({ id: args.moduleId, events }, null, 2) }],
            };
        }
        case "liveApiFindFunction": {
            const { functionName, moduleId, strictSearch } = args;
            const items = strictSearch ? findFunctionExact(functionName) : findFunction(functionName, moduleId);
            return {
                content: [{ type: "text", text: JSON.stringify({ items, searchPhrase: functionName }, null, 2) }],
            };
        }
        case "liveApiGetFunctionCode": {
            const { functionName, moduleId } = args;
            const code = getFunctionCode(functionName, moduleId);
            if (!code) {
                return { content: [{ type: "text", text: "Function not found: " + functionName + " in " + moduleId }] };
            }
            return { content: [{ type: "text", text: code }] };
        }
        case "liveApiFindByReflection": {
            const { functionName, returnCode } = args;
            const items = findFunction(functionName);
            const result = returnCode
                ? items.map((i) => ({ ...i, code: getFunctionCode(i.name, i.moduleId) || "" }))
                : items;
            return {
                content: [{ type: "text", text: JSON.stringify({ items: result, searchPhrase: functionName }, null, 2) }],
            };
        }
        case "liveApiFindByNamespace": {
            const { namespace } = args;
            const result = findByNamespace(namespace);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        case "liveApiReindex": {
            const result = indexAllModules();
            return {
                content: [{
                        type: "text",
                        text: JSON.stringify({ status: "ok", modulesIndexed: result.modulesIndexed, functionsIndexed: result.functionsIndexed }),
                    }],
            };
        }
        case "envInfo": {
            try {
                const phpVersion = execSync("php --version 2>/dev/null | head -1").toString().trim();
                const phpModulesStr = execSync("php -m 2>/dev/null").toString().trim();
                const memoryLimit = execSync("php -r 'echo ini_get(\"memory_limit\");' 2>/dev/null").toString().trim();
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({
                                system: {
                                    os: execSync("uname -a").toString().trim(),
                                    hostname: execSync("hostname").toString().trim(),
                                },
                                bitrix: { modules: listModules() },
                                php: {
                                    version: phpVersion,
                                    extensions: phpModulesStr.split("\n").filter(Boolean),
                                    memoryLimit,
                                },
                            }, null, 2),
                        }],
                };
            }
            catch {
                return { content: [{ type: "text", text: JSON.stringify({ error: "Failed to get env info" }) }] };
            }
        }
        default:
            throw new Error("Unknown tool: " + name);
    }
}
//# sourceMappingURL=tools.js.map