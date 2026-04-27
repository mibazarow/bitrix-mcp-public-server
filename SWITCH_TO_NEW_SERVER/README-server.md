# Bitrix MCP Server

MCP-сервер для AI-агентов (Cursor, PhpStorm, Claude Desktop, Kilo и др.), предоставляющий справочную информацию по Bitrix Framework через LiveAPI, документацию и семантический поиск.

## Подключение

### PhpStorm (`/.ai/mcp/mcp.json`)
```json
{
  "mcpServers": {
    "bitrix": {
      "command": "npx",
      "args": ["mcp-remote", "https://bxmcp.example.com"]
    }
  }
}
```

### Cursor (`mcp.json`)
```json
{
  "mcpServers": {
    "bitrix": {
      "command": "npx",
      "args": ["mcp-remote", "https://bxmcp.example.com"]
    }
  }
}
```

### Claude Desktop
```json
{
  "mcpServers": {
    "bitrix": {
      "command": "npx",
      "args": ["mcp-remote", "https://bxmcp.example.com"]
    }
  }
}
```

### Через curl
```bash
# Установить SSE-соединение
curl -s -N https://bxmcp.example.com/sse

# В другом окне: извлечь sessionId из вывода и отправить запрос
SESSION_ID="..."
curl -s -X POST "https://bxmcp.example.com/messages?sessionId=$SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"liveApiListModules","arguments":{}}}'
```

## Инструменты MCP

| Инструмент | Описание |
|-----------|----------|
| `liveApiListModules` | Список установленных модулей с версиями |
| `liveApiGetModuleFunctions` | Функции модуля (с пагинацией через cursor) |
| `liveApiGetModuleEvents` | События модуля |
| `liveApiFindFunction` | Поиск функции по имени (с опцией strict) |
| `liveApiGetFunctionCode` | Код функции с PHPDoc |
| `liveApiFindByReflection` | Reflection-поиск по всему проекту |
| `searchDocs` | Семантический поиск по документации |
| `envInfo` | Информация об окружении: OS, PHP, модули Bitrix |

## MCP Resources

- `bx-docs://list` — дерево файлов документации
- `bx-docs://{path}` — содержимое конкретного `.md` файла

## Health check

```bash
curl https://bxmcp.example.com/health
curl http://127.0.0.1:3100/health  # с сервера
```

## Архитектура

```
VDS:
  - MCP Server (Node.js, TypeScript) — порт 3100
  - Embeddings Service (Python, FastAPI) — порт 8000
  - nginx с SSL на bxmcp.example.com → localhost:3100
  - SQLite индексы: /opt/bitrix-mcp/data/index.db
  - Документация: /opt/bitrix-mcp/data/docs (git clone)
  - PHP ядро Bitrix: /var/www/SITE.ru/bitrix/modules/
```

## Cron

- `reindex.sh` — каждый час: проверка изменений PHP-файлов, переиндексация
- `update-docs.sh` — ежедневно в 3:00: git pull документации + переиндексация embeddings
