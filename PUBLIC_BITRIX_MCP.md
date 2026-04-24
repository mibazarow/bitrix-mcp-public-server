# Публичный MCP-сервер для Bitrix Framework

## Исходные данные

| Параметр | Значение |
|----------|----------|
| Домен | `camouf.ru` (основной, Bitrix), `bxmcp.camouf.ru` (поддомен, MCP) |
| Сервер | VDS, Ubuntu 22.04/24.04 LTS |
| Путь к Bitrix | `/home/bitrix/ext_www/camouf.ru` |
| Версия Bitrix | Последняя стабильная (через BitrixEnv) |
| MCP сервер | Самописный, Node.js/TypeScript |
| Доступ | Публичный, без токенов и аутентификации |


## Задача

Создать MCP-сервер, который предоставляет AI-агентам 
(Cursor, PhpStorm, Claude Desktop,
Kilo и др.) справочную информацию по **Bitrix Framework**, полностью независимый от
движка 1С-Битрикс

**Инструменты MCP:**
- LiveAPI — поиск функций, классов, методов, событий, констант ядра Bitrix
- Документация Bitrix Framework в виде MCP resources
- Семантический поиск по документации через embeddings

**Требования:**
- Полностью свой код, своя архитектура (не модуль для Bitrix)
- Публичный — любой может подключиться без токена
- Источник PHP-кода для LiveAPI — установленный на этом же сервере Bitrix
- Автоматическая актуализация индексов при обновлении ядра Bitrix
- Embeddings-сервис на Python (sentence-transformers) для семантического поиска

## Зачем это нужно

LLM общего назначения (Claude, GPT, DeepSeek и др.) знакомы с Bitrix Framework
в той или иной мере, но их знания — это замороженный срез обучающей выборки:

- Они **галлюцинируют**: выдумывают несуществующие методы, путают сигнатуры
  и неймспейсы, особенно в редких модулях.
- Они **не знают свежих изменений** — после обновления ядра модель продолжает
  отвечать по старой версии.
- Они **не точны в деталях**: типы аргументов, возвращаемые значения,
  унаследованные методы — всё это модель «угадывает», а не знает.

**MCP-сервер решает это через LiveAPI** — вместо того чтобы полагаться на
«воспоминания» модели, он подставляет ей реальный PHP-код ядра прямо с сервера.
Когда Claude или Cursor видят актуальную сигнатуру `\Bitrix\Main\ORM\Query\Query::setFilter()`
из исходников, они перестают гадать.

**Семантический поиск (RAG)** по документации делает то же самое для ответов
на высокоуровневые вопросы: «как работают права доступа?», «как добавить
свой обработчик события?» — модель не вспоминает, а извлекает ответ из
актуальной документации.

Итог: проект полезен, когда нужна **точность**, а не «вроде похоже».
Для поверхностных вопросов он избыточен, для реальной разработки — нет.

---

## Выбранный подход: Node.js/TypeScript

MCP-сервер пишется на TypeScript с официальным SDK `@modelcontextprotocol/sdk`.

| Компонент | Технология |
|-----------|-----------|
| MCP SDK | `@modelcontextprotocol/sdk` (Anthropic) |
| PHP-парсер | `php-parser` (npm) — AST-парсер, либо regex-сканирование сигнатур |
| Хранилище | SQLite через `better-sqlite3` |
| Документация | git clone `github.com/bitrix-tools/framework-docs` |
| Embeddings | Python-микросервис (FastAPI + sentence-transformers `intfloat/multilingual-e5-small`) |

---

## Архитектура сервера

```
┌──────────────────────────────────────────────────┐
│                   VDS                             │
│                                                    │
│  ┌────────────────────────────┐                    │
│  │  Bitrix CMS                │   источник PHP     │
│  │  /home/bitrix/ext_www/     │   для LiveAPI      │
│  │  camouf.ru/bitrix/  │                    │
│  └────────────────────────────┘                    │
│         │                                          │
│         ▼ php-файлы модулей                        │
│  ┌──────────────────────────────────────┐         │
│  │  MCP Server (Node.js) — порт 3100    │         │
│  │                                      │         │
│  │  ┌─────────┐ ┌──────────┐ ┌───────┐ │         │
│  │  │ LiveAPI │ │  Docs    │ │Search │ │         │
│  │  │ Service │ │ Service  │ │Service│ │         │
│  │  └────┬────┘ └────┬─────┘ └───┬───┘ │         │
│  │       │           │           │      │         │
│  │  ┌────┴───────────┴───────────┴───┐  │         │
│  │  │  SQLite (/opt/bitrix-mcp/)     │  │         │
│  │  └────────────────────────────────┘  │         │
│  └──────────────────────────────────────┘         │
│         │                                          │
│  ┌──────┴───────────────┐  ┌────────────────────┐ │
│  │ Docs markdown (git)  │  │ Embeddings Service │ │
│  │ /opt/bitrix-mcp/docs │  │ Python, порт 8000  │ │
│  └──────────────────────┘  └────────────────────┘ │
│                                                    │
│  ┌──────────────────────────────────────────┐     │
│  │  nginx (прокси)                          │     │
│  │  bxmcp.camouf.ru → localhost:3100 │     │
│  │  (или camouf.ru/mcp)                     │     │
│  │  camouf.ru/embed → localhost:8000 │     │
│  └──────────────────────────────────────────┘     │
└──────────────────────────────────────────────────┘
```

**Ключевое решение**: MCP-сервер не запускается внутри Bitrix. Он читает PHP-файлы
непосредственно из установленного Bitrix: `/home/bitrix/ext_www/camouf.ru/bitrix/modules/`.
Так индексы всегда соответствуют реальной версии ядра на сервере.

---

## Компоненты

### 1. PHP-исходники ядра (LiveAPI)

Путь к модулям Bitrix:

```
/home/bitrix/ext_www/camouf.ru/bitrix/modules/
```

При обновлении Bitrix файлы меняются «на месте» — индексер обнаружит изменения
по дате модификации файлов и переиндексирует только изменившиеся модули.

### 2. Индексатор PHP (LiveAPI)

Сканирует PHP-файлы и собирает:

- Функции: `function functionName(...)`
- Методы классов: `public function methodName(...)`, `public static function methodName(...)`
- События: вызовы `GetModuleEvents(...)`, `\Bitrix\Main\EventManager::getInstance()->registerEventHandler(...)`
- Константы: `define(...)`, class constants
- Классы/интерфейсы/трейты: extends, implements, use traits

Реализация — `php-parser` (npm), AST-обход. Для v1 допустимо regex-сканирование.

### 3. Схема SQLite

```sql
CREATE TABLE modules (
    id TEXT PRIMARY KEY,
    name TEXT,
    version TEXT,
    path TEXT,
    indexed_at DATETIME
);

CREATE TABLE functions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    module_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    phpdoc TEXT,
    code TEXT,
    args TEXT,          -- JSON: [{type, name, defaultValue}]
    is_method INTEGER DEFAULT 0,
    class_name TEXT,
    visibility TEXT     -- 'public'|'protected'|'private'
);

CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    module_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    fired_in_function TEXT
);

CREATE TABLE classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    module_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    type TEXT,        -- 'class'|'interface'|'trait'
    extends TEXT,
    implements TEXT,
    phpdoc TEXT
);

CREATE TABLE doc_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB
);
```

### 4. Документация

```bash
mkdir -p /opt/bitrix-mcp/data
cd /opt/bitrix-mcp/data
git clone --depth 1 https://github.com/bitrix-tools/framework-docs.git docs
```

MCP resources:
- `bx-docs://list` — дерево файлов и директорий
- `bx-docs://{path}` — содержимое конкретного .md файла

Embeddings-индексация:
- .md → чанки (по заголовкам или ~500 токенов)
- чанк → embedding (Python-сервис)
- чанк + embedding → SQLite
- поиск: embedding запроса → cosine similarity → топ-N чанков

### 5. Embeddings-сервис (Python)

```python
# /opt/bitrix-mcp/python/embeddings-service.py
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

systemd:

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

### 6. MCP-сервер (TypeScript)

Структура проекта:

```
/opt/bitrix-mcp/
├── src/
│   ├── index.ts                 # точка входа, инициализация MCP
│   ├── liveapi/
│   │   ├── indexer.ts           # обход PHP-файлов Bitrix, парсинг
│   │   ├── storage.ts           # SQLite: запись/чтение
│   │   └── tools.ts             # инструменты LiveAPI
│   ├── docs/
│   │   ├── service.ts           # работа с markdown
│   │   └── resources.ts         # MCP resources
│   ├── search/
│   │   ├── embeddings.ts        # HTTP-клиент к Python-сервису
│   │   └── service.ts           # поиск по embeddings
│   └── utils/
│       ├── php-parser.ts        # парсер / regex
│       └── config.ts            # конфигурация (пути, порты)
├── package.json
├── tsconfig.json
└── data/
    ├── docs/                    # git clone framework-docs
    └── index.db                 # SQLite
```

Инструменты MCP:

| Инструмент | Описание |
|-----------|----------|
| `liveApiListModules` | Список установленных модулей с версиями |
| `liveApiGetModuleFunctions` | Функции модуля (с пагинацией через cursor) |
| `liveApiGetModuleEvents` | События модуля |
| `liveApiFindFunction` | Поиск функции по имени (с опцией strict) |
| `liveApiGetFunctionCode` | Код функции с PHPDoc |
| `liveApiFindByReflection` | Reflection-поиск по всему проекту (с опцией returnCode) |
| `searchDocs` | Семантический поиск по документации |
| `envInfo` | Информация об окружении: версия PHP, версии модулей Bitrix, OS |

### 7. Транспорт

MCP-сервер работает в режиме **HTTP + SSE** (не stdio).
Клиенты подключаются через `mcp-remote` по HTTPS на поддомен `bxmcp.camouf.ru`.

Изначально проксирование было настроено через location `/mcp/` на основном домене
`camouf.ru`, но Bitrix CMS перехватывает корневые запросы, и `mcp-remote` не может
корректно открыть SSE-соединение (пытается стучаться на `/`, а там 404).
Выделенный поддомен решает эту проблему полностью.

Запуск:

```typescript
// src/index.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';

const app = express();
const server = new Server({ name: 'bxmcp', version: '1.0.0' }, {
    capabilities: { tools: {}, resources: {} }
});

// регистрация инструментов и ресурсов...

app.get('/sse', (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    server.connect(transport);
});

app.post('/messages', (req, res) => {
    // обработка входящих сообщений от клиента
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(3100);
```

### 8. nginx (прокси)

Основной конфиг (`camouf.ru`) оставляет location `/mcp/`, `/embed/` и `/health`
для обратной совместимости. После применения DNS поддомен `bxmcp.camouf.ru`
получает отдельный server block, проксирующий корень на MCP-сервер.

```nginx
# /etc/nginx/sites-enabled/camouf.ru.conf (фрагмент — location внутри server блоков)

# ===== Основной домен (Bitrix CMS) =====
# server_name camouf.ru;
# Bitrix обслуживает корень (/), MCP доступен по /mcp/

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

# ===== Поддомен (MCP-сервер) =====
# Когда DNS bxmcp.camouf.ru применится — раскомментировать:
# server {
#     listen 443 ssl;
#     server_name bxmcp.camouf.ru;
#
#     ssl_certificate /etc/letsencrypt/live/camouf.ru/fullchain.pem;
#     ssl_certificate_key /etc/letsencrypt/live/camouf.ru/privkey.pem;
#
#     location / {
#         proxy_pass http://127.0.0.1:3100;
#         proxy_http_version 1.1;
#         proxy_set_header Upgrade $http_upgrade;
#         proxy_set_header Connection "upgrade";
#         proxy_set_header Host $host;
#         proxy_read_timeout 86400s;
#         proxy_buffering off;
#         proxy_cache off;
#         limit_req zone=mcp burst=20 nodelay;
#     }
#
#     location /embed/ {
#         rewrite ^/embed(/.*)$ $1 break;
#         proxy_pass http://127.0.0.1:8000;
#     }
# }
#
# server {
#     listen 80;
#     server_name bxmcp.camouf.ru;
#     return 301 https://$server_name$request_uri;
# }
```

**Важно:** MCP-сервер на порту 3100 — один. Разница только в том, через какой
nginx server block к нему обращаться. Через поддомен все IDE-клиенты (`mcp-remote`)
работают «из коробки», без `/mcp/` в пути.

---

## Инфраструктура

### 9. systemd-сервис для MCP

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

### 10. rate limiting (nginx)

```nginx
# /etc/nginx/conf.d/ratelimit.conf
limit_req_zone $binary_remote_addr zone=mcp:10m rate=10r/s;
```

### 11. cron

```bash
# /etc/cron.d/bxmcp
# каждый час — проверка изменений в PHP-файлах, переиндексация при необходимости
0 * * * * bitrix /opt/bitrix-mcp/scripts/reindex.sh

# каждый день в 3:00 — обновление документации + переиндексация embeddings
0 3 * * * bitrix /opt/bitrix-mcp/scripts/update-docs.sh
```

`reindex.sh`:
```bash
#!/bin/bash
BITRIX_PATH="/home/bitrix/ext_www/camouf.ru/bitrix/modules"
LAST_RUN="/opt/bitrix-mcp/data/last_reindex"
CHANGES=$(find "$BITRIX_PATH" -name "*.php" -newer "$LAST_RUN" 2>/dev/null | wc -l)

if [ "$CHANGES" -gt 0 ] || [ ! -f "$LAST_RUN" ]; then
    curl -s -X POST http://127.0.0.1:3100/admin/reindex
fi
touch "$LAST_RUN"
```

---

## Инструменты MCP (детально)

### `liveApiListModules`

Вход: `{}`
Выход: массив `{id, name, version}`

### `liveApiGetModuleFunctions`

Вход: `{moduleId: string, cursor?: string}`
Выход: `{id, version, functions: [{name, source: {file, line}, args}], nextCursor?}`

### `liveApiGetModuleEvents`

Вход: `{moduleId: string}`
Выход: `{id, version, events: [{name, source: {file, line}, firedInFunc}]}`

### `liveApiFindFunction`

Вход: `{functionName: string, moduleId?: string, strictSearch?: boolean}`
Выход: `{items: [{name, moduleId, source: {file, line}}], searchPhrase}`

### `liveApiGetFunctionCode`

Вход: `{functionName: string, moduleId: string}`
Выход: `string` (код функции с PHPDoc)

### `liveApiFindByReflection`

Вход: `{functionName: string, returnCode?: boolean}`
Выход: `{items: [{name, code?}], searchPhrase}`

### `searchDocs`

Вход: `{query: string}`
Выход: `{results: [{filePath, chunkIndex, text, score}]}`

### `envInfo`

Вход: `{}`
Выход: `{system: {os, hostname}, bitrix: {edition, version, modules}, php: {version, extensions, memoryLimit, maxExecutionTime}}`

---

## Этапы реализации

### Этап 1: Фундамент

- [ ] Инициализация проекта TypeScript + `@modelcontextprotocol/sdk`
- [ ] Базовый MCP-сервер с HTTP SSE транспортом на порту 3100
- [ ] tools/list + tools/call (заглушки)
- [ ] Индексатор PHP-функций (рекурсивный обход `/home/bitrix/ext_www/camouf.ru/bitrix/modules/`, парсинг)
- [ ] SQLite storage: запись и поиск функций
- [ ] Инструменты: `liveApiListModules`, `liveApiFindFunction`, `liveApiGetFunctionCode`
- [ ] nginx-прокси на camouf.ru, SSL

### Этап 2: LiveAPI

- [ ] Индексация классов (extends, implements)
- [ ] Индексация событий (GetModuleEvents + EventManager::registerEventHandler)
- [ ] `liveApiGetModuleFunctions` (с пагинацией через cursor)
- [ ] `liveApiGetModuleEvents`
- [ ] `liveApiFindByReflection`
- [ ] `envInfo`
- [ ] Скрипт автоиндексации (cron, `reindex.sh`)

### Этап 3: Документация

- [ ] git clone `framework-docs` в `/opt/bitrix-mcp/data/docs`
- [ ] MCP resources (список + чтение файлов)
- [ ] Разбиение .md на чанки
- [ ] Python-сервис embeddings (FastAPI + `intfloat/multilingual-e5-small`)
- [ ] Индексация чанков в SQLite
- [ ] Инструмент `searchDocs` (cosine similarity)
- [ ] systemd-сервис `bxmcp-embeddings`
- [ ] Скрипт `update-docs.sh` (cron: ежедневно)

### Этап 4: Стабилизация

- [ ] Логирование запросов (morgan или аналог)
- [ ] Rate limiting (nginx)
- [ ] fail2ban
- [ ] Health-check эндпоинт
- [ ] Graceful shutdown (SIGTERM → закрытие SSE)
- [ ] systemd-сервис `bxmcp`
- [ ] Мониторинг: `systemctl status`, uptime
- [ ] Инструкция по подключению в README

---

## Оценка ресурсов VDS

| Компонент | RAM | CPU | Диск |
|-----------|-----|-----|------|
| Bitrix CMS (не используется, но установлен) | ~1 GB | ~1 | ~5 GB |
| MCP-сервер (Node.js) | ~200 MB | 0.5 | — |
| Markdown-документация (git) | — | — | ~200 MB |
| SQLite-индексы | — | — | ~100 MB |
| Embeddings (Python + модель) | ~2 GB | 1-2 | ~2 GB |
| **Итого** | **~3.5 GB** | **2 vCPU** | **~10 GB** |

Рекомендуемая конфигурация: **4 GB RAM / 2 vCPU / 20-40 GB SSD**.

---

## Альтернативы embeddings

| Вариант | RAM | Скорость | Зависимости |
|---------|-----|----------|------------|
| `sentence-transformers` (E5-small) | ~2 GB | ~100ms | Python, ~1 GB модель |
| `transformers.js` (внутри Node.js) | ~1 GB | ~200ms | npm пакет, без Python |
| OpenAI `text-embedding-3-small` | 0 | ~300ms (сеть) | API-ключ, плата |
| Ollama | ~2 GB | ~150ms | Docker/служба |

Для старта: Python-сервис (точность) или transformers.js (простота без второго рантайма).

---

## Примеры подключения

### PhpStorm (`/.ai/mcp/mcp.json`)

```json
{
  "mcpServers": {
    "bitrix": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://bxmcp.camouf.ru"
      ]
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
      "args": [
        "mcp-remote",
        "https://bxmcp.camouf.ru"
      ]
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
      "args": [
        "mcp-remote",
        "https://bxmcp.camouf.ru"
      ]
    }
  }
}
```

**Вариант для обратной совместимости** (пока DNS не применился, или через curl):

```bash
npx mcp-remote https://camouf.ru/mcp
```

`mcp-remote` — HTTP-to-stdio мост. Установка: `npx mcp-remote`.

---

## Статус реализации (24.04.2026)

### Что сделано и работает

- [x] Проект `/opt/bitrix-mcp` инициализирован: TypeScript + `@modelcontextprotocol/sdk` v1.26.0 + Express + SQLite
- [x] MCP-сервер запущен как systemd-сервис `bxmcp` на порту 3100
- [x] HTTP SSE транспорт: `GET /sse` → `event: endpoint`, `POST /messages?sessionId=X` → `202 Accepted`, ответ через SSE `event: message`
- [x] Множественные SSE-соединения (Map по sessionId)
- [x] nginx-прокси: `camouf.ru/mcp/` → `localhost:3100` (SSL, rate limit, rewrite)
- [x] Индексация PHP-функций Bitrix: просканировано 53 модуля, ~90 MB SQLite-индекс
- [x] SQLite: таблицы `modules`, `functions`, `classes`, `events`, `doc_chunks` — созданы и заполнены
- [x] Embeddings-сервис (Python, FastAPI, `intfloat/multilingual-e5-small`) — systemd `bxmcp-embeddings`, порт 8000

**Подтверждённые MCP-инструменты (все 9):**

| Инструмент | Статус |
|---|---|
| `liveApiListModules` | ✅ — 53 модуля |
| `liveApiGetModuleFunctions` | ✅ — с cursor-пагинацией |
| `liveApiGetModuleEvents` | ✅ |
| `liveApiFindFunction` | ✅ — поиск по имени |
| `liveApiGetFunctionCode` | ✅ — код + PHPDoc |
| `liveApiFindByReflection` | ✅ |
| `envInfo` | ✅ — OS, PHP, модули |
| `liveApiReindex` | ✅ — асинхронный |
| `searchDocs` | ✅ — 1749 чанков с embeddings, семантический поиск |

### Что в процессе

- ⏳ **Миграция на StreamableHTTPServerTransport**: MCP SDK рекомендует новый транспорт вместо SSE. При обновлении SDK сломается — нужно мигрировать.

### Что сделано дополнительно

1. **MCP resources `bx-docs://`**: 109 ресурсов — `bx-docs://list` (дерево) + 108 конкретных `.md` файлов. Код протестирован, `ListResourcesRequestSchema` и `ReadResourceRequestSchema` работают.
2. **Cron-скрипты**: `reindex.sh` (каждый час: проверка изменений PHP → переиндексация) и `update-docs.sh` (ежедневно в 3:00: git pull документации + переиндексация embeddings) — созданы в `/opt/bitrix-mcp/scripts/`, добавлены в `/etc/cron.d/bxmcp`.
3. **`.gitignore`**: создан (`node_modules/`, `dist/`, `data/index.db*`, `data/docs/`, `.env`, `*.log`).
4. **Логирование**: подключён `pino` — логи в stdout, уровень через `LOG_LEVEL` (по умолчанию `info`).
5. **Graceful shutdown**: `SIGTERM`/`SIGINT` → закрытие HTTP-сервера → закрытие всех SSE-транспортов → exit (с таймаутом 10s).
6. **fail2ban**: установлен, jail `bxmcp` (400 ошибки на `/mcp/messages`), nginx rate limiting `10r/s`.
7. **README**: создан `/opt/bitrix-mcp/README.md` с инструкциями по подключению и списком инструментов.
8. **Обновление документации**: git pull через `update-docs.sh` по cron ежедневно.
9. **Embedding-пайплайн**: `clearDocChunks()` вызывается перед `indexAllDocs()` — старые embeddings удаляются корректно.
10. **Версии модулей**: `modules.version` заполняется из `install/version.php` (`$arModuleVersion["VERSION"]`).

### Проверка подключения

```bash
# Через mcp-remote (рекомендуемый способ для IDE — после применения DNS)
npx mcp-remote https://bxmcp.camouf.ru

# Через mcp-remote (обратная совместимость, через основной домен)
npx mcp-remote https://camouf.ru/mcp

# Через curl (ручная проверка, через /mcp/ на основном домене)
SESSION_ID=$(curl -s -N https://camouf.ru/mcp/sse 2>&1 | grep sessionId | sed 's/.*sessionId=//')
curl -s -X POST "https://camouf.ru/mcp/messages?sessionId=$SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"liveApiListModules","arguments":{}}}'
```

---

## Переход на поддомен bxmcp.camouf.ru

### Почему решили отказаться от изначальной схемы

Изначально MCP-сервер был спроектирован как location `/mcp/` на основном домене
`camouf.ru`. Это работало через curl (ручные запросы к `/mcp/sse` и `/mcp/messages`),
но оказалось **несовместимо с клиентскими MCP-библиотеками** (`mcp-remote`,
IDE-плагины Cursor, PhpStorm, Claude Desktop).

Проблема: `mcp-remote` и другие клиенты ожидают, что **SSE-соединение открывается
на корне домена** (`GET /`) или на переданном URL как есть. Они не умеют добавлять
`/mcp/` к путям. При подключении к `https://camouf.ru/mcp` клиент стучится на
`GET /sse` и `POST /messages`, а не на `GET /mcp/sse` и `POST /mcp/messages`.
Nginx с rewrite `/mcp/` не спасает, потому что клиент никогда не шлёт `/mcp/`
в пути — он знает только про корень.

Выделенный поддомен `bxmcp.camouf.ru` решает это:
- Bitrix CMS висит на основном домене — ничего не меняется.
- MCP-сервер висит на поддомене — клиенты стучатся на корень, nginx проксирует
  прозрачно, никаких конфликтов.
- Один порт 3100, один процесс — разница только в nginx server_name.

### Текущий статус — ✅ ВЫПОЛНЕНО 24.04.2026

DNS `bxmcp.camouf.ru` → `188.243.139.238` (применился).
SSL-сертификат получен (Certbot, `bxmcp.camouf.ru`).
Server block добавлен в `/etc/nginx/sites-enabled/camouf.ru.conf`.
nginx перезагружен, всё работает.

**Проверка:**
```bash
curl -s -N https://bxmcp.camouf.ru/sse
# → event: endpoint, data: /messages?sessionId=...

# Инструменты:
curl ... tools/call {"name":"liveApiListModules","arguments":{}} → 53 модуля
curl ... tools/call {"name":"searchDocs","arguments":{"query":"права доступа"}} → результаты
curl ... tools/call {"name":"envInfo","arguments":{}} → информация об окружении
curl https://bxmcp.camouf.ru/health → {"status":"ok"}
```

Исправлен баг: `express.json()` глобально парсил тело запроса, что ломало `raw-body` в SSEServerTransport. Убран для `/messages`.

**Подключение клиентов:**
```json
{
  "mcpServers": {
    "bitrix": {
      "command": "npx",
      "args": ["mcp-remote", "https://bxmcp.camouf.ru"]
    }
  }
}
```
