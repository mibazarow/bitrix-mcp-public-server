# Публичный MCP-сервер для Bitrix Framework

## Исходные данные

| Параметр | Значение |
|----------|----------|
| Домен | `camouf.ru` (Bitrix), `bxmcp.camouf.ru` (MCP) |
| Сервер | VDS, Ubuntu 22.04 |
| Путь к Bitrix | `/home/bitrix/ext_www/camouf.ru` |
| MCP сервер | Node.js/TypeScript, порт 3100 |
| Доступ | Публичный, без аутентификации |
| SDK | `@modelcontextprotocol/sdk` v1.29.0 |

## Задача

MCP-сервер, предоставляющий AI-агентам (Cursor, PhpStorm, Claude Desktop, Kilo) справочную информацию по **Bitrix Framework**, полностью независимый от движка 1С-Битрикс.

**Инструменты:**
- LiveAPI — поиск функций, классов, методов, событий, констант ядра Bitrix
- Документация Bitrix Framework в виде MCP resources
- Семантический поиск по документации через embeddings

**Требования:**
- Полностью свой код, своя архитектура (не модуль для Bitrix)
- Публичный — любой может подключиться без токена
- Источник PHP-кода для LiveAPI — установленный на этом же сервере Bitrix
- Embeddings-сервис на Python (sentence-transformers) для семантического поиска

## Архитектура

```
VDS
├── Bitrix CMS — источник PHP для LiveAPI
│   └── /home/bitrix/ext_www/camouf.ru/bitrix/modules/
│
├── MCP Server (Node.js, порт 3100)
│   ├── LiveAPI Service — парсинг PHP, SQLite-индекс
│   ├── Docs Service — markdown документация (git)
│   ├── Search Service — семантический поиск (embeddings)
│   └── SQLite — /opt/bitrix-mcp/data/index.db
│
├── Embeddings Service (Python, FastAPI, порт 8000)
│   └── sentence-transformers intfloat/multilingual-e5-small
│
└── nginx — прокси:
    ├── bxmcp.camouf.ru → localhost:3100 (MCP)
    ├── camouf.ru/mcp/ → localhost:3100 (основной домен)
    └── camouf.ru/embed/ → localhost:8000 (embeddings)
```

**Ключевое решение**: MCP-сервер читает PHP-файлы непосредственно из установленного Bitrix. Индексы всегда соответствуют реальной версии ядра.

## Транспорт

**Streamable HTTP** (MCP спецификация 2025-03-26). Один `StreamableHTTPServerTransport` с `sessionIdGenerator` и `enableJsonResponse: true`.

- `POST /` — JSON-RPC запросы (initialize, tools/call, resources/list и т.д.)
- SDK сам обрабатывает GET (SSE-стрим при необходимости)
- Клиент присылает заголовки: `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `Mcp-Protocol-Version`
- Сервер возвращает `mcp-session-id` в заголовке после initialize
- Последующие запросы содержат `Mcp-Session-Id` и `Mcp-Protocol-Version` в заголовках

## Компоненты

### 1. Индексатор PHP (LiveAPI)

Сканирует PHP-файлы Bitrix и собирает в SQLite:
- Функции: сигнатуры, аргументы, PHPDoc, полный код
- Методы классов: с указанием класса и visibility
- Классы/интерфейсы/трейты: extends, implements
- События: `GetModuleEvents`, `EventManager::registerEventHandler`
- Константы: `define()`, class constants

Реализация — regex-парсинг (`src/utils/php-parser.ts`).

### 2. Схема SQLite

```sql
CREATE TABLE modules (id TEXT PRIMARY KEY, name TEXT, version TEXT, path TEXT, indexed_at TEXT);
CREATE TABLE functions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, module_id TEXT NOT NULL, file_path TEXT NOT NULL, line_number INTEGER NOT NULL, phpdoc TEXT, code TEXT, args TEXT, is_method INTEGER DEFAULT 0, class_name TEXT, visibility TEXT DEFAULT 'public');
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, module_id TEXT NOT NULL, file_path TEXT, line_number INTEGER, fired_in_function TEXT);
CREATE TABLE classes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, module_id TEXT NOT NULL, file_path TEXT NOT NULL, line_number INTEGER NOT NULL, type TEXT, extends TEXT, implements TEXT, phpdoc TEXT);
CREATE TABLE doc_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, embedding BLOB);
```

### 3. Документация

```bash
git clone --depth 1 https://github.com/bitrix-tools/framework-docs.git /opt/bitrix-mcp/data/docs
```

MCP resources: `bx-docs://list` (дерево), `bx-docs://{path}` (содержимое .md файла).

Embeddings-пайплайн: .md → чанки по заголовкам (~500 токенов) → embedding (Python-сервис) → SQLite. Поиск: cosine similarity.

### 4. Embeddings-сервис (Python)

```python
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

app = FastAPI()
model = SentenceTransformer('intfloat/multilingual-e5-small')

class EmbeddingRequest(BaseModel):
    text: str

@app.post("/embed")
def embed(request: EmbeddingRequest):
    vec = model.encode(request.text, normalize_embeddings=True)
    return {"embedding": vec.tolist()}

@app.get("/health")
def health():
    return {"status": "ok"}
```

### 5. MCP-сервер (TypeScript)

```
/opt/bitrix-mcp/
├── src/
│   ├── index.ts                 # точка входа, Express + StreamableHTTP
│   ├── liveapi/
│   │   ├── indexer.ts           # обход PHP-файлов, парсинг
│   │   ├── storage.ts           # SQLite: запись/чтение
│   │   └── tools.ts             # инструменты LiveAPI
│   ├── docs/
│   │   ├── service.ts           # работа с markdown
│   │   └── resources.ts         # MCP resources
│   ├── search/
│   │   ├── embeddings.ts        # HTTP-клиент к Python-сервису
│   │   └── service.ts           # поиск по embeddings
│   └── utils/
│       ├── php-parser.ts        # regex-парсер PHP
│       └── config.ts            # конфигурация
├── package.json / tsconfig.json
├── dist/                        # скомпилированный JS
├── data/
│   ├── docs/                    # git clone framework-docs
│   └── index.db                 # SQLite (~90 MB)
├── scripts/
│   ├── reindex.sh               # cron: каждый час
│   └── update-docs.sh           # cron: ежедневно в 3:00
└── python/
    └── embeddings-service.py    # FastAPI
```

## Инструменты MCP

| Инструмент | Описание |
|-----------|----------|
| `liveApiListModules` | Список модулей с версиями |
| `liveApiGetModuleFunctions` | Функции модуля (пагинация cursor) |
| `liveApiGetModuleEvents` | События модуля |
| `liveApiFindFunction` | Поиск функции по имени (strict опция) |
| `liveApiGetFunctionCode` | Код функции с PHPDoc |
| `liveApiFindByReflection` | Поиск по всему проекту (returnCode опция) |
| `searchDocs` | Семантический поиск по документации |
| `liveApiReindex` | Принудительная переиндексация |
| `envInfo` | Информация об окружении |

## nginx

```nginx
# /etc/nginx/conf.d/ratelimit.conf
limit_req_zone $binary_remote_addr zone=mcp:10m rate=10r/s;

# /etc/nginx/sites-enabled/camouf.ru.conf

# Основной домен — Bitrix CMS
# server_name camouf.ru;
location /mcp/ {
    rewrite ^/mcp(/.*)$ $1 break;
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400s;
    proxy_buffering off;
    proxy_cache off;
    limit_req zone=mcp burst=20 nodelay;
}

location /embed/ {
    rewrite ^/embed(/.*)$ $1 break;
    proxy_pass http://127.0.0.1:8000;
}

# Поддомен bxmcp.camouf.ru
# server { listen 443 ssl; server_name bxmcp.camouf.ru;
#     ssl_certificate ...;
#     location / { proxy_pass http://127.0.0.1:3100; ... }
#     location /embed/ { rewrite ^/embed(/.*)$ $1 break; proxy_pass http://127.0.0.1:8000; }
# }
```

## systemd

```ini
# /etc/systemd/system/bxmcp.service
[Unit]
Description=BxMCP Server
After=network.target bxmcp-embeddings.service
Requires=bxmcp-embeddings.service

[Service]
User=bitrix
Group=bitrix
WorkingDirectory=/opt/bitrix-mcp
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=BITRIX_PATH=/home/bitrix/ext_www/camouf.ru/bitrix/modules
Environment=EMBEDDINGS_URL=http://127.0.0.1:8000
Environment=PORT=3100

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/bxmcp-embeddings.service
[Unit]
Description=BxMCP Embeddings Service
After=network.target

[Service]
User=bitrix
Group=bitrix
WorkingDirectory=/opt/bitrix-mcp/python
ExecStart=/opt/bitrix-mcp/python/venv/bin/python -m uvicorn embeddings-service:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## cron

```bash
# /etc/cron.d/bxmcp
0 * * * * bitrix /opt/bitrix-mcp/scripts/reindex.sh        # каждый час
0 3 * * * bitrix /opt/bitrix-mcp/scripts/update-docs.sh    # ежедневно в 3:00
```

## Подключение клиентов

```json
{
  "mcpServers": {
    "bitrix": {
      "command": "npx",
      "args": ["-y", "mcp-remote@0.1.26", "--transport", "sse-only", "https://bxmcp.camouf.ru"]
    }
  }
}
```

## Проверка через curl

```bash
# 1. Initialize — получить sessionId
SESSION_ID=$(curl -s -X POST https://bxmcp.camouf.ru/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}' | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['sessionId'])" 2>/dev/null)

# Если sessionId не в теле ответа, он в заголовке mcp-session-id

# 2. tools/list
curl -s -X POST https://bxmcp.camouf.ru/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Protocol-Version: 2025-03-26" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# 3. tools/call
curl -s -X POST https://bxmcp.camouf.ru/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Protocol-Version: 2025-03-26" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"liveApiListModules","arguments":{}}}'
```

## Статус реализации (24.04.2026)

- [x] MCP-сервер на Express + `StreamableHTTPServerTransport` (SDK 1.29.0)
- [x] Индексация 53 модулей Bitrix, ~90 MB SQLite
- [x] Все 9 инструментов MCP (LiveAPI + searchDocs + envInfo + reindex)
- [x] MCP resources: `bx-docs://` (109 ресурсов)
- [x] Embeddings-сервис (Python, FastAPI, `intfloat/multilingual-e5-small`)
- [x] nginx-прокси: `camouf.ru/mcp/` и `bxmcp.camouf.ru`
- [x] systemd: `bxmcp` + `bxmcp-embeddings`
- [x] Cron: автоиндексация (каждый час) + обновление docs (ежедневно)
- [x] Логирование (pino), graceful shutdown, rate limiting, fail2ban
- [x] README с инструкциями подключения
