# BxMCP — MCP-сервер для Bitrix Framework

**Публичный MCP-сервер**, который даёт AI-агентам (Cursor, Claude Desktop, PhpStorm, Kilo) точную, актуальную информацию по Bitrix Framework напрямую из исходного кода и документации.

## Быстрый старт

```json
{
  "mcpServers": {
    "bitrix": {
      "url": "https://bxmcp.camouf.ru/mcp"
    }
  }
}

> **Для Cursor / Claude Desktop / Kilo** — вставьте в `.cursor/mcp.json`, `claude_desktop_config.json` или `/.ai/mcp/mcp.json` (если ваш клиент поддерживает `url`, иначе используйте `mcp-remote`):

<details>
<summary>Вариант с npx mcp-remote (если клиент требует command/args)</summary>

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

</details>

## Инструменты (24 шт.)

### Модули и структура

| Инструмент | Что делает |
|---|---|
| `liveApiListModules` | Список всех 53 модулей Bitrix с версиями |
| `liveApiGetModuleFunctions` | Функции модуля (курсорная пагинация) |
| `liveApiGetModuleClasses` | Классы модуля (курсорная пагинация) |
| `liveApiGetModuleEvents` | События, зарегистрированные в модуле |
| `liveApiGetAllEvents` | Все события разом — по всем модулям |
| `liveApiGetEventHandler` | Обработчики конкретного события |
| `liveApiGetModuleStructure` | Файловый путь модуля на сервере |
| `liveApiGetModuleDependencies` | Зависимости модуля (requireModule) |

### Компоненты и ORM

| Инструмент | Что делает |
|---|---|
| `liveApiListComponents` | Список проиндексированных компонентов (`comp:<namespace>:<name>`) |
| `liveApiListDataManagers` | DataManager-классы ORM в модуле или по всем модулям |
| `liveApiGetEntityFields` | Поля ORM-сущности из `getMap()` DataManager-класса |

### Поиск по коду

| Инструмент | Что делает |
|---|---|
| `liveApiFindFunction` | Поиск функции/метода по имени во всех модулях (~90K+) |
| `liveApiFindByReflection` | Поиск по всему проекту, опционально с кодом |
| `liveApiFindByNamespace` | Поиск по PHP-неймспейсу (Bitrix\Main\IO) |
| `liveApiFindByInterface` | Все классы, реализующие заданный интерфейс |
| `liveApiGetFunctionCode` | Полный исходный код функции с PHPDoc |
| `liveApiGetFunctionUsage` | Где вызывается функция (grep по кодбейсу) |

### Классы

| Инструмент | Что делает |
|---|---|
| `liveApiGetClassCode` | Путь к файлу класса и PHPDoc |
| `liveApiGetClassMethods` | Все методы класса с сигнатурами и visibility |
| `liveApiGetClassConstants` | Все константы класса |
| `liveApiGetClassConstantValue` | Значение конкретной константы из исходников |
| `liveApiGetClassHierarchy` | extends/implements для класса |

### Документация

| Инструмент | Что делает |
|---|---|
| `liveApiGetDocResource` | Содержимое файла документации по пути |
| `searchDocs` | Семантический поиск по документации Bitrix Framework |

## Примеры промптов

```
Найди функцию GetList в модуле main и покажи её код с сигнатурой
```

```
Как правильно использовать \Bitrix\Main\ORM\Query\Query? Поищи в документации про ORM
```

```
Какие события есть в модуле sale? Покажи все зарегистрированные события
```

## Как это устроено

```
BxMCP Server (Node.js, порт 3100)
  ├── LiveAPI — парсит PHP-файлы Bitrix (/bitrix/modules/ и /bitrix/components/)
  ├── Docs — поиск по markdown-документации (git)
  ├── Embeddings (Python, порт 8000) — EmbeddingGemma 2, семантический поиск
  ├── Analytics — SQLite-статистика использования (/admin/stats, /admin/usage)
  └── SQLite — индекс функций, классов, событий, чанков docs
```

Транспорт: **Streamable HTTP** (MCP spec 2025-03-26). Сервер читает PHP-файлы ядра Bitrix напрямую — индексы всегда соответствуют реальной версии.

### EmbeddingGemma 2

Семантический поиск работает на **`google/embeddinggemma-2`** (Apache 2.0, text-only
бэкбон 270M, fp32, 256-мерные векторы через Matryoshka-усечение).

Сервис эмбеддингов общий: один процесс обслуживает несколько потребителей через
**профили** — профиль задаёт обязательный для этой модели task-префикс и размерность.

| Профиль | Префикс | Кто использует |
|---|---|---|
| `docs_query` | `task: search result \| query: ` | запросы `searchDocs` |
| `docs_passage` | `title: none \| text: ` | индексация документации |
| `site_query` / `site_passage` | те же | BXADMIN-S (индекс сайта) |
| `code_query` | `task: code retrieval \| query: ` | поиск по коду |
| `generic` | без префикса | служебное |

Полная инструкция по установке — [HOWTO.md](HOWTO.md).

## Проверка (без sessionId — достаточно POST)

```bash
curl -s -X POST https://bxmcp.camouf.ru/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"liveApiListModules","arguments":{}},"id":1}' | jq .result.content[0].text
```

## Лицензия

- [MIT](LICENSE)

## Ресурсы

- **Сервер**: `https://bxmcp.camouf.ru`
- **Health**: `https://bxmcp.camouf.ru/health` (включает модель, размерность и подпись индекса)
- **Статистика использования**: `https://camouf.ru/mcp-stats` (JSON), `https://camouf.ru/mcp-usage`
- **Архитектура**: `PUBLIC_BITRIX_MCP.md`
- **Развёртывание с нуля**: `HOWTO.md`

## Ограничения

- Rate limit на уровне приложения не настроен (в nginx `limit_req` не используется)
- Публичный доступ, аутентификация не требуется; `/admin/stats` может требовать `STATS_TOKEN`, если он задан в окружении
