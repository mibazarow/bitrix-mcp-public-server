export const CONFIG = {
  bitrixPath: process.env.BITRIX_PATH || "/home/bitrix/ext_www/camouf.ru/bitrix/modules",
  dbPath: process.env.DB_PATH || "/opt/bitrix-mcp/data/index.db",
  docsPath: process.env.DOCS_PATH || "/opt/bitrix-mcp/data/docs",
  embeddingsUrl: process.env.EMBEDDINGS_URL || "http://127.0.0.1:8000",
  port: parseInt(process.env.PORT || "3100", 10),
  mcpServerName: "bxmcp",
  mcpServerVersion: "1.0.0",
};
