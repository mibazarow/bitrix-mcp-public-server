# BxMCP — MCP-сервер для Bitrix Framework

**Публичный MCP-сервер**, который даёт AI-агентам (Cursor, Claude Desktop, PhpStorm, Kilo и др.) точную, актуальную информацию по Bitrix Framework напрямую из исходного кода и документации.

## Зачем это нужно

LLM (Claude, GPT, DeepSeek) знают Bitrix Framework в общем, но их знания — замороженный срез обучающей выборки. Они:

- **Галлюцинируют** — выдумывают несуществующие методы, путают сигнатуры и неймспейсы
- **Не знают свежих изменений** — после обновления ядра продолжают отвечать по старой версии
- **Неточны в деталях** — типы аргументов, возвращаемые значения, унаследованные методы — модель «угадывает»

BxMCP решает это через **LiveAPI**: AI-агент получает реальный PHP-код ядра прямо с сервера и актуальную документацию через семантический поиск (RAG).

## Быстрый старт

Подключите MCP-сервер в вашем инструменте:

**Cursor** (`.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "bitrix": {
      "command": "npx",
      "args": [
        "@modelcontextprotocol/mcp-remote",
        "https://bxmcp.camouf.ru"
      ]
    }
  }
}
```

**PhpStorm** (`/.ai/mcp/mcp.json`):
```json
{
  "mcpServers": {
    "bitrix": {
      "command": "npx",
      "args": [
        "@modelcontextprotocol/mcp-remote",
        "https://bxmcp.camouf.ru"
      ]
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "bitrix": {
      "command": "npx",
      "args": [
        "@modelcontextprotocol/mcp-remote",
        "https://bxmcp.camouf.ru"
      ]
    }
  }
}
```

После подключения AI-агент получит доступ к инструментам Bitrix Framework.

## Доступные инструменты

### Поиск по исходному коду (LiveAPI)

| Инструмент | Что делает |
|---|---|
| `liveApiFindFunction` | Ищет функцию/метод по имени во всех модулях |
| `liveApiGetFunctionCode` | Возвращает полный исходный код функции с PHPDoc |
| `liveApiGetModuleFunctions` | Список функций модуля (с пагинацией) |
| `liveApiGetModuleEvents` | Все события, зарегистрированные в модуле |
| `liveApiFindByReflection` | Поиск по всему проекту, опционально с кодом |
| `liveApiListModules` | Список всех модулей Bitrix на сервере |
| `liveApiReindex` | Переиндексация PHP-файлов вручную |

### Поиск по документации

| Инструмент | Что делает |
|---|---|
| `searchDocs` | Семантический поиск по документации Bitrix Framework |

### Информация об окружении

| Инструмент | Что делает |
|---|---|
| `envInfo` | Версия PHP, список модулей, ОС, расширения |

## Примеры использования в промптах

```
Найди функцию GetList в модуле main и покажи её код с сигнатурой
```

```
Как правильно использовать \Bitrix\Main\ORM\Query\Query?
Поищи в документации про ORM
```

```
Какие события есть в модуле sale?
Покажи все зарегистрированные события
```

```
Какая версия PHP на сервере и какие модули Bitrix установлены?
```

## Как это устроено

```
BxMCP Server (Node.js, порт 3100)
  ├── LiveAPI — парсит PHP-файлы Bitrix (/bitrix/modules/)
  ├── Docs — поиск по markdown-документации
  ├── Embeddings (Python) — семантический поиск
  └── SQLite — индекс функций, классов, событий, чанков docs
```

Сервер читает PHP-файлы ядра `Bitrix` напрямую из установки на сервере. Индексы всегда соответствуют реальной версии ядра. Никакой зависимости от движка 1С-Битрикс — полностью независимый код.

## Проверка подключения

```bash
# Через mcp-remote
npx @modelcontextprotocol/mcp-remote https://bxmcp.camouf.ru

# Ручная проверка через curl
SESSION_ID=$(curl -s -N https://bxmcp.camouf.ru/sse 2>&1 | grep sessionId | sed 's/.*sessionId=//')
curl -s -X POST "https://bxmcp.camouf.ru/messages?sessionId=$SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"liveApiListModules","arguments":{}}}'
```

## Ресурсы

- **Сервер**: `https://bxmcp.camouf.ru`
- **Здоровье**: `https://bxmcp.camouf.ru/health`
- **Архитектура**: см. `PUBLIC_BITRIX_MCP.md`

## Ограничения

- Скорость ответа зависит от загрузки CPU на сервере (индексация — ресурсоёмкий процесс)
- На один IP — не более 10 запросов/сек (rate limit nginx)
- Публичный доступ, аутентификация не требуется
