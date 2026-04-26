import { listModules, getModuleFunctions, getModuleEvents, findFunction, findFunctionExact, getFunctionCode, findByNamespace, getClasses, getClassCode, getClassMethods, getClassConstants, getClassConstantValue, getFunctionUsage, getModuleStructure, getClassHierarchy, findByInterface, getModuleDependencies, getAllEventHandlers, getDocResource } from "./storage.js";
import { readdirSync } from "fs";
import { join } from "path";
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
        name: "liveApiGetClassCode",
        description: "Get the file path and PHPDoc for a class",
        inputSchema: {
            type: "object",
            properties: {
                className: { type: "string" },
                moduleId: { type: "string" },
            },
            required: ["className", "moduleId"],
        },
    },
    {
        name: "liveApiGetClassMethods",
        description: "Get all methods of a class with signatures and visibility",
        inputSchema: {
            type: "object",
            properties: {
                className: { type: "string" },
                moduleId: { type: "string" },
            },
            required: ["className", "moduleId"],
        },
    },
    {
        name: "liveApiGetClassConstants",
        description: "Get all constants of a class",
        inputSchema: {
            type: "object",
            properties: {
                className: { type: "string" },
                moduleId: { type: "string" },
            },
            required: ["className", "moduleId"],
        },
    },
    {
        name: "liveApiGetClassConstantValue",
        description: "Get the value of a specific class constant from source code",
        inputSchema: {
            type: "object",
            properties: {
                className: { type: "string" },
                moduleId: { type: "string" },
                constantName: { type: "string" },
            },
            required: ["className", "moduleId", "constantName"],
        },
    },
    {
        name: "liveApiGetClassHierarchy",
        description: "Get extends and implements info for a class",
        inputSchema: {
            type: "object",
            properties: {
                className: { type: "string" },
                moduleId: { type: "string" },
            },
            required: ["className", "moduleId"],
        },
    },
    {
        name: "liveApiFindByInterface",
        description: "Find all classes that implement a given interface",
        inputSchema: {
            type: "object",
            properties: {
                interfaceName: { type: "string" },
            },
            required: ["interfaceName"],
        },
    },
    {
        name: "liveApiGetAllEvents",
        description: "Get all registered events across all modules",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "liveApiGetModuleStructure",
        description: "Get the filesystem path of a module",
        inputSchema: {
            type: "object",
            properties: {
                moduleId: { type: "string" },
            },
            required: ["moduleId"],
        },
    },
    {
        name: "liveApiGetModuleDependencies",
        description: "Get dependencies of a module (from requireModule calls)",
        inputSchema: {
            type: "object",
            properties: {
                moduleId: { type: "string" },
            },
            required: ["moduleId"],
        },
    },
    {
        name: "liveApiGetFunctionUsage",
        description: "Find where a function is used (called) across the codebase using grep",
        inputSchema: {
            type: "object",
            properties: {
                functionName: { type: "string" },
                moduleId: { type: "string" },
            },
            required: ["functionName"],
        },
    },
    {
        name: "liveApiGetDocResource",
        description: "Get content of a documentation file by path",
        inputSchema: {
            type: "object",
            properties: {
                docPath: { type: "string" },
            },
            required: ["docPath"],
        },
    },
    {
        name: "envInfo",
        description: "Get environment info: OS, PHP version, Bitrix modules, memory",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    // liveApiReindex intentionally removed — admin-only, triggered via POST /admin/reindex
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
        case "liveApiGetClassCode": {
            const { className, moduleId } = args;
            const code = getClassCode(className, moduleId);
            if (!code) {
                return { content: [{ type: "text", text: "Class not found: " + className + " in " + moduleId }] };
            }
            return { content: [{ type: "text", text: code }] };
        }
        case "liveApiGetClassMethods": {
            const { className, moduleId } = args;
            const methods = getClassMethods(className, moduleId);
            return { content: [{ type: "text", text: JSON.stringify({ className, moduleId, methods }, null, 2) }] };
        }
        case "liveApiGetClassConstants": {
            const { className, moduleId } = args;
            const constants = getClassConstants(className, moduleId);
            return { content: [{ type: "text", text: JSON.stringify({ className, moduleId, constants }, null, 2) }] };
        }
        case "liveApiGetClassConstantValue": {
            const { className, moduleId, constantName } = args;
            const constant = getClassConstantValue(className, moduleId, constantName);
            if (!constant) {
                return { content: [{ type: "text", text: "Constant not found: " + className + "::" + constantName }] };
            }
            return { content: [{ type: "text", text: JSON.stringify(constant, null, 2) }] };
        }
        case "liveApiGetClassHierarchy": {
            const { className, moduleId } = args;
            const hierarchy = getClassHierarchy(className, moduleId);
            if (!hierarchy) {
                return { content: [{ type: "text", text: "Class not found: " + className + " in " + moduleId }] };
            }
            return { content: [{ type: "text", text: JSON.stringify(hierarchy, null, 2) }] };
        }
        case "liveApiFindByInterface": {
            const { interfaceName } = args;
            const items = findByInterface(interfaceName);
            return { content: [{ type: "text", text: JSON.stringify({ interfaceName, items }, null, 2) }] };
        }
        case "liveApiGetAllEvents": {
            const events = getAllEventHandlers();
            return { content: [{ type: "text", text: JSON.stringify({ events }, null, 2) }] };
        }
        case "liveApiGetModuleStructure": {
            const { moduleId } = args;
            const structure = getModuleStructure(moduleId);
            if (!structure) {
                return { content: [{ type: "text", text: "Module not found: " + moduleId }] };
            }
            const files = listPhpFiles(structure.path);
            return { content: [{ type: "text", text: JSON.stringify({ ...structure, fileCount: files.length, files }, null, 2) }] };
        }
        case "liveApiGetModuleDependencies": {
            const { moduleId } = args;
            const deps = getModuleDependencies(moduleId);
            return { content: [{ type: "text", text: JSON.stringify({ moduleId, dependencies: deps }, null, 2) }] };
        }
        case "liveApiGetFunctionUsage": {
            const { functionName, moduleId } = args;
            const items = getFunctionUsage(functionName, moduleId);
            return { content: [{ type: "text", text: JSON.stringify({ functionName, usages: items }, null, 2) }] };
        }
        case "liveApiGetDocResource": {
            const { docPath } = args;
            const content = getDocResource(docPath);
            if (!content) {
                return { content: [{ type: "text", text: "Document not found: " + docPath }] };
            }
            return { content: [{ type: "text", text: content }] };
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
function listPhpFiles(dir) {
    const files = [];
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.startsWith(".") || entry.name === "node_modules")
                    continue;
                files.push(...listPhpFiles(fullPath));
            }
            else if (entry.name.endsWith(".php")) {
                files.push(fullPath.replace(dir + "/", ""));
            }
        }
    }
    catch { }
    return files;
}
//# sourceMappingURL=tools.js.map