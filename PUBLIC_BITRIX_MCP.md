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
│   └── sentence-transformers google/embeddinggemma-2 (text+image, fp32, 256d)
│
└── nginx — прокси:
    ├── bxmcp.camouf.ru → localhost:3100 (MCP)
    ├── bxmcp.camouf.ru/embed/ → localhost:8000 (embeddings)
    └── camouf.ru/mcp-usage, /mcp-stats → localhost:3100/admin/*
```

**Ключевое решение**: MCP-сервер читает PHP-файлы непосредственно из установленного Bitrix. Индексы всегда соответствуют реальной версии ядра.

**Stateless-режим**: SDK-проверка `_initialized` отключена установкой `_initialized = true` и `sessionIdGenerator = undefined` на внутреннем `_webStandardTransport`. Клиенту не нужны `initialize` и `Mcp-Session-Id` — достаточно POST с `Content-Type: application/json` и `Accept: application/json, text/event-stream`.

## Транспорт

**Streamable HTTP** (MCP спецификация 2025-03-26). Сервер работает в **stateless-режиме** — клиенту не нужно отправлять `initialize` или `Mcp-Session-Id`.

- `POST /` — любые JSON-RPC запросы (tools/list, tools/call, resources/list и т.д.)
- SDK сам обрабатывает GET (SSE-стрим при необходимости)
- Клиент присылает заголовки: `Content-Type: application/json`, `Accept: application/json, text/event-stream`
- `initialize` не требуется — SDK-проверка `_initialized` отключена на уровне транспорта
- `Mcp-Session-Id` не требуется — session management отключён (sessionIdGenerator = undefined)
- Каждый HTTP-запрос создаёт новый транспорт. Сессии не сохраняются между запросами

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
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- подпись индекса эмбеддингов
```

`embedding` — BLOB из `dim` × 4 байт (little-endian float32). Размерность задаётся
`EMBEDDING_DIM` (сейчас 256) и проверяется при загрузке кэша и при дисковом поиске:
записи другой длины отбрасываются, а не сравниваются вслепую.

`meta.embeddings_signature` = `<модель>@<размерность>` (например
`google/embeddinggemma-2@256`). Несовпадение с текущей конфигурацией означает
полный пересчёт `doc_chunks` при следующей индексации.

### 3. Документация

```bash
git clone --depth 1 https://github.com/bitrix-tools/framework-docs.git /opt/bitrix-mcp/data/docs
```

MCP resources: `bx-docs://list` (дерево), `bx-docs://{path}` (содержимое .md файла).

Embeddings-пайплайн: .md → чанки по заголовкам (≤1500 символов) → embedding (Python-сервис,
профиль `docs_passage`) → SQLite. Поиск: cosine similarity по 256-мерным векторам,
запрос кодируется профилем `docs_query`.

Индексация **инкрементальная**: чанк с неизменившимся содержимым не пересчитывается,
исчезнувшие чанки удаляются. Полный пересчёт — только при смене подписи индекса.

### 4. Embeddings-сервис (Python)

Модель — **`google/embeddinggemma-2`**, Apache 2.0. Грузится в режиме text+image:
`config_kwargs={"audio_config": None}` — audio-энкодер отключён, в памяти 440M из 740M.
Текст и картинки делят одно 768-мерное пространство, поэтому текстовый запрос находит
изображения.

Включение vision **не меняет текстовые векторы** (`max_abs_diff = 0.0`), поэтому смена
модальности не требует переиндексации текста. Картинки при этом дорогие: ~88 s на
изображение при 280 soft-токенах и ~20–25 s при 70 — их индексируют отдельной ночной
очередью.

Ограничения, зашитые в конфиг:

- **только fp32** — в `float16` модель возвращает NaN или молча деградирует;
- `max_seq_length = 512` — окно модели 8K, но чанки ≤1500 символов (~380 токенов),
  ограничение защищает от патологических входов;
- `EMBEDDING_THREADS = 2` — оптимум для 2 vCPU, больше потоков даёт оверхед;
- CPU-сборка torch (`+cpu`), иначе pip притянет CUDA-колёса на 5 GB без пользы.

Сервис общий для нескольких потребителей: профиль задаёт обязательный для этой
модели task-префикс и размерность (MRL: 128/256/512/768).

| Профиль | Префикс | Потребитель |
|---|---|---|
| `docs_query` | `task: search result \| query: ` | `searchDocs` |
| `docs_passage` | `title: none \| text: ` | индексация документации |
| `site_query` / `site_passage` | те же | BXADMIN-S (индекс сайта) |
| `code_query` | `task: code retrieval \| query: ` | поиск по коду |
| `generic` | без префикса | служебное |

Эндпоинты: `POST /embed`, `POST /embed/batch` (до 32 текстов), `GET /health`,
`GET /profiles`. Кодирование сериализовано мьютексом — параллельные вызовы
не конкурируют за два ядра.

Производительность на 2 vCPU Sandy Bridge: ~0.45 s на короткий запрос,
~2.6 s на чанк 1500 символов. Полная переиндексация 5581 чанка — ~3 часа,
ежедневная инкрементальная — секунды.

### 5. MCP-сервер (TypeScript)

```
/opt/bitrix-mcp/
├── src/
│   ├── index.ts                 # точка входа, Express + StreamableHTTP
│   ├── analytics.ts             # статистика использования (SQLite)
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
│   ├── index.db                 # SQLite-индекс (~500 MB)
│   └── analytics.db             # SQLite-статистика
├── scripts/
│   ├── reindex.sh               # cron: ежедневно в 1:00
│   └── update-docs.sh           # cron: ежедневно в 4:00
└── python/
    ├── embeddings-service.py    # FastAPI
    └── requirements.txt
```

## Инструменты MCP (24 шт.)

### Модули и структура
| Инструмент | Описание |
|---|---|
| `liveApiListModules` | Список всех 53 модулей с версиями |
| `liveApiGetModuleFunctions` | Функции модуля (курсорная пагинация) |
| `liveApiGetModuleClasses` | Классы модуля (курсорная пагинация) |
| `liveApiGetModuleEvents` | События модуля |
| `liveApiGetAllEvents` | Все события всех модулей |
| `liveApiGetEventHandler` | Обработчики конкретного события |
| `liveApiGetModuleStructure` | Файловый путь модуля |
| `liveApiGetModuleDependencies` | Зависимости модуля |

### Компоненты и ORM
| Инструмент | Описание |
|---|---|
| `liveApiListComponents` | Проиндексированные компоненты (`comp:<namespace>:<name>`) |
| `liveApiListDataManagers` | DataManager-классы ORM |
| `liveApiGetEntityFields` | Поля ORM-сущности из `getMap()` |

### Поиск по коду
| Инструмент | Описание |
|---|---|
| `liveApiFindFunction` | Поиск функции/метода по имени (strict опция) |
| `liveApiFindByReflection` | Поиск по всему проекту (returnCode опция) |
| `liveApiFindByNamespace` | Поиск по PHP-неймспейсу |
| `liveApiFindByInterface` | Все классы по интерфейсу |
| `liveApiGetFunctionCode` | Код функции с PHPDoc |
| `liveApiGetFunctionUsage` | Где вызывается функция (grep) |

### Классы
| Инструмент | Описание |
|---|---|
| `liveApiGetClassCode` | Путь к файлу класса + PHPDoc |
| `liveApiGetClassMethods` | Методы класса с сигнатурами |
| `liveApiGetClassConstants` | Константы класса |
| `liveApiGetClassConstantValue` | Значение константы из исходников |
| `liveApiGetClassHierarchy` | extends/implements |

### Документация
| Инструмент | Описание |
|---|---|
| `liveApiGetDocResource` | Файл документации по пути |
| `searchDocs` | Семантический поиск по документации |

## nginx

Актуальная конфигурация — [`src/nginx-camouf.ru.conf`](src/nginx-camouf.ru.conf):

- `bxmcp.camouf.ru` → `127.0.0.1:3100` (MCP в корне), `/embed/` → `127.0.0.1:8000`
- `camouf.ru` → apache (`127.0.0.1:8090`), плюс `/mcp-usage` и `/mcp-stats` → `127.0.0.1:3100/admin/*`
- `limit_req` не используется

## systemd

Актуальные unit-файлы — [`src/bxmcp.service`](src/bxmcp.service) и [`src/bxmcp-embeddings.service`](src/bxmcp-embeddings.service):

- `bxmcp.service` — `User=root`, `ExecStart=/usr/local/bin/bxmcp-node /opt/bitrix-mcp/dist/index.js`, `PORT=3100`,
  `EMBEDDING_DIM=256`, `EMBEDDING_MODEL=google/embeddinggemma-2`
- `bxmcp-embeddings.service` — uvicorn на `127.0.0.1:8000` из `/opt/bitrix-mcp/python/venv-gemma2`

## cron

Актуальное расписание — [`src/cron-bxmcp`](src/cron-bxmcp) (`/etc/cron.d/bxmcp`):

```bash
0 1 * * * root /opt/bitrix-mcp/scripts/reindex.sh >> /var/log/bxmcp-reindex.log 2>&1
0 4 * * * root /opt/bitrix-mcp/scripts/update-docs.sh >> /var/log/bxmcp-docs.log 2>&1
```

`reindex.sh` запускает переиндексацию только если mtime `.php` новее маркера
`data/last_reindex`. Когда запускает — индексирует **полностью** (`clearModuleData`
по каждому модулю), ~11 минут на 53 модуля и 918 компонентов. Проверка реагирует
на новые и изменённые файлы; удаление модуля без изменения соседних файлов детектор
не увидит (лечится ручным `POST /admin/reindex`).

Индексация документации, наоборот, инкрементальная: неизменные чанки пропускаются,
исчезнувшие удаляются. Полный пересчёт — только при смене подписи индекса.

## Подключение клиентов

```json
{
  "mcpServers": {
    "bitrix": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://bxmcp.camouf.ru"]
    }
  }
}
```

## Проверка через curl (sessionId не требуется)

Сервер работает в stateless-режиме — клиенту не нужно слать initialize или указывать `Mcp-Session-Id`.

```bash
# tools/list
curl -s -X POST https://bxmcp.camouf.ru/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# tools/call
curl -s -X POST https://bxmcp.camouf.ru/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"liveApiListModules","arguments":{}}}'
```

## Статус реализации (27.10.2026)

- [x] MCP-сервер на Express + `StreamableHTTPServerTransport` (SDK 1.29.0)
- [x] Индексация 53 модулей Bitrix, ~333 MB SQLite
- [x] **24 инструмента** MCP (LiveAPI: модули, функции, классы, события, константы, неймспейсы, компоненты, ORM + searchDocs)
- [x] MCP resources: `bx-docs://` (109 ресурсов)
- [x] Embeddings-сервис (Python, FastAPI, `google/embeddinggemma-2`, text+image, fp32, 256d, профили)
- [x] Stateless-режим — клиенту не нужны initialize/sessionId
- [x] Исправлена ошибка `ERR_HTTP_HEADERS_SENT` при множественных вызовах инструментов
- [x] nginx-прокси: `bxmcp.camouf.ru` и `camouf.ru/mcp/`
- [x] systemd: `bxmcp` + `bxmcp-embeddings`
- [x] Cron: автоиндексация (каждый час) + обновление docs (ежедневно)
- [x] Логирование (pino), graceful shutdown, rate limiting, fail2ban
- [x] README с инструкциями подключения
