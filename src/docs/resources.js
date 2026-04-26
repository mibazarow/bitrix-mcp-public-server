import { getDocTree, getDocContent, listMdFiles } from "./service.js";
function buildResourceDefinitions() {
    const resources = [
        {
            uri: "bx-docs://list",
            name: "Docs Tree",
            description: "Directory tree of documentation files",
            mimeType: "application/json",
        },
    ];
    const files = listMdFiles();
    for (const f of files) {
        resources.push({
            uri: "bx-docs://" + f,
            name: f,
            description: "Document: " + f,
            mimeType: "text/markdown",
        });
    }
    return resources;
}
export const resourceDefinitions = buildResourceDefinitions();
export function handleResourceRead(uri) {
    if (uri === "bx-docs://list") {
        return {
            contents: [{
                    uri,
                    mimeType: "application/json",
                    text: JSON.stringify(getDocTree(), null, 2),
                }],
        };
    }
    const docPath = uri.replace("bx-docs://", "");
    const content = getDocContent(docPath);
    if (!content) {
        throw new Error("Document not found: " + docPath);
    }
    return {
        contents: [{
                uri,
                mimeType: "text/markdown",
                text: content,
            }],
    };
}
//# sourceMappingURL=resources.js.map