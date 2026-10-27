const bitrixRoot = process.env.BITRIX_PATH
  ? process.env.BITRIX_PATH.replace(/\/modules\/?$/, "")
  : "/home/bitrix/ext_www/camouf.ru/bitrix";

export const CONFIG = {
  bitrixPath: process.env.BITRIX_PATH || bitrixRoot + "/modules",
  componentsPath: process.env.COMPONENTS_PATH || bitrixRoot + "/components",
  dbPath: process.env.DB_PATH || "/opt/bitrix-mcp/data/index.db",
  docsPath: process.env.DOCS_PATH || "/opt/bitrix-mcp/data/docs",
  embeddingsUrl: process.env.EMBEDDINGS_URL || "http://127.0.0.1:8000",
  embeddingDim: parseInt(process.env.EMBEDDING_DIM || "256", 10),
  embeddingModel: process.env.EMBEDDING_MODEL || "google/embeddinggemma-2",
  port: parseInt(process.env.PORT || "3100", 10),
  mcpServerName: "bxmcp",
  mcpServerVersion: "1.1.0",
};
