# BxMCP — MCP-сервер для Bitrix Framework

**Публичный MCP-сервер**, который даёт AI-агентам (Cursor, Claude Desktop, PhpStorm, Kilo) точную, актуальную информацию по Bitrix Framework напрямую из исходного кода и документации.

## Быстрый старт

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

Куда вставить: `.cursor/mcp.json`, `/.ai/mcp/mcp.json`, `claude_desktop_config.json`.

## Инструменты

### LiveAPI (поиск по исходному коду Bitrix)

| Инструмент | Что делает |
|---|---|
| `liveApiFindFunction` | Ищет функцию/метод по имени во всех модулях |
| `liveApiGetFunctionCode` | Полный исходный код функции с PHPDoc |
| `liveApiGetModuleFunctions` | Список функций модуля (пагинация) |
| `liveApiGetModuleEvents` | События, зарегистрированные в модуле |
| `liveApiFindByReflection` | Поиск по всему проекту, опционально с кодом |
| `liveApiListModules` | Список всех модулей Bitrix на сервере |
| `liveApiReindex` | Переиндексация PHP-файлов вручную |

### Документация

| Инструмент | Что делает |
|---|---|
| `searchDocs` | Семантический поиск по документации Bitrix Framework |

### Окружение

| Инструмент | Что делает |
|---|---|
| `envInfo` | Версия PHP, список модулей, ОС, расширения |

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

## Проверка

```bash
npx @modelcontextprotocol/mcp-remote https://bxmcp.camouf.ru
```

## Ресурсы

- **Сервер**: `https://bxmcp.camouf.ru`
- **Health**: `https://bxmcp.camouf.ru/health`
- **Архитектура**: `PUBLIC_BITRIX_MCP.md`

## Ограничения

- Rate limit: 10 запросов/сек на IP (nginx)
- Публичный доступ, аутентификация не требуется
