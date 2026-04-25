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

## Инструменты (21 шт.)

### Модули и структура

| Инструмент | Что делает |
|---|---|
| `liveApiListModules` | Список всех 53 модулей Bitrix с версиями |
| `liveApiGetModuleFunctions` | Функции модуля (курсорная пагинация) |
| `liveApiGetModuleClasses` | Классы модуля (курсорная пагинация) |
| `liveApiGetModuleEvents` | События, зарегистрированные в модуле |
| `liveApiGetAllEvents` | Все события разом — по всем модулям |
| `liveApiGetModuleStructure` | Файловый путь модуля на сервере |
| `liveApiGetModuleDependencies` | Зависимости модуля (requireModule) |

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

### Документация и окружение

| Инструмент | Что делает |
|---|---|
| `liveApiGetDocResource` | Содержимое файла документации по пути |
| `searchDocs` | Семантический поиск по документации Bitrix Framework |
| `envInfo` | Версия PHP, ОС, список модулей, память |

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
  ├── LiveAPI — парсит PHP-файлы Bitrix (/bitrix/modules/)
  ├── Docs — поиск по markdown-документации (git)
  ├── Embeddings (Python) — семантический поиск
  └── SQLite — индекс функций, классов, событий, чанков docs
```

Транспорт: **Streamable HTTP** (MCP spec 2025-03-26). Сервер читает PHP-файлы ядра Bitrix напрямую — индексы всегда соответствуют реальной версии.

## Проверка (без sessionId — достаточно POST)

```bash
curl -s -X POST https://bxmcp.camouf.ru/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"liveApiListModules","arguments":{}},"id":1}' | jq .result.content[0].text
```

## Ресурсы

- **Сервер**: `https://bxmcp.camouf.ru`
- **Health**: `https://bxmcp.camouf.ru/health`
- **Архитектура**: `PUBLIC_BITRIX_MCP.md`

## Ограничения

- Rate limit: 10 запросов/сек на IP (nginx)
- Публичный доступ, аутентификация не требуется
