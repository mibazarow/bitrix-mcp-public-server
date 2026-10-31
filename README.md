# BxMCP — MCP-сервер для Bitrix Framework

**MCP-сервер, который вы разворачиваете сами.** Он даёт AI-агентам (Cursor, Claude Desktop,
PhpStorm, Kilo) точную и актуальную информацию по Bitrix Framework — напрямую из исходного
кода вашей установки и из документации.

Публичной инсталляции, к которой можно просто подключиться, больше нет. Этот репозиторий —
комплект для развёртывания собственного экземпляра: **локально** на машине разработчика или
**на сервере** рядом с боевым Bitrix, при желании — публично за nginx.

Сервер полностью независим от движка: это отдельный сервис, а не модуль Bitrix. Он ничего
не пишет в `/bitrix` — только читает PHP-файлы.

---

## Как поднять

### Вариант 1: отдать агенту (рекомендуется)

Скопируйте репозиторий на нужную машину и передайте агенту такую инструкцию:

```
Разверни BxMCP из этого репозитория на текущей машине.

1. Прочитай HOWTO.md целиком — это инструкция по установке.
2. Проверь требования (Node 22+, Python 3.12+, RAM, swap) и скажи,
   чего не хватает.
3. Спроси меня: разворачиваем локально или на сервере с Bitrix,
   и какой путь к установке Bitrix (BITRIX_PATH).
4. Выполни шаги из HOWTO.md по порядку: зависимости, сборка, сервис
   эмбеддингов, systemd, индексация.
5. После каждого этапа проверяй результат теми командами, что есть в HOWTO.
6. В конце покажи мне готовый JSON для подключения MCP-клиента.

Не меняй файлы в /bitrix. Все пути и порты бери из HOWTO.md.
```

Агент прочитает [HOWTO.md](HOWTO.md), задаст уточняющие вопросы и выполнит установку.
Инструкция написана так, чтобы её можно было воспроизвести на чистой машине.

### Вариант 2: вручную

Кратко, подробности — в [HOWTO.md](HOWTO.md):

```bash
# 1. зависимости, Node 22+, Python 3.12, swap
# 2. код
cd /opt && git clone <этот-репозиторий> bitrix-mcp && cd bitrix-mcp
npm install && npm run build

# 3. сервис эмбеддингов (CPU-сборка torch)
cd src/python
python3 -m venv venv-gemma2
./venv-gemma2/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
./venv-gemma2/bin/pip install -r requirements.txt

# 4. документация
cd /opt/bitrix-mcp/data
git clone --depth 1 https://github.com/bitrix-tools/framework-docs.git docs

# 5. systemd-юниты и запуск
cp /opt/bitrix-mcp/src/bxmcp.service /opt/bitrix-mcp/src/bxmcp-embeddings.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now bxmcp-embeddings bxmcp

# 6. индексация
curl -X POST http://127.0.0.1:3100/admin/reindex             # модули (~11 мин)
curl -X POST http://127.0.0.1:3100/admin/reindex-components  # компоненты
curl -X POST http://127.0.0.1:3100/admin/reindex-docs        # документация (~3 ч)
```

### Требования

| Параметр | Минимум |
|---|---|
| CPU | 2 vCPU |
| RAM | 6 GB + **swap 2–4 GB** |
| Диск | 25 GB (индекс модулей ~500 MB + веса модели ~3 GB) |
| Node.js | 22+ |
| Python | 3.10+ (проверено на 3.12) |
| Bitrix | установлен на этой же машине (или локальная копия) |

GPU не нужен: эмбеддинги считаются на CPU в fp32.

## Где размещать

| Сценарий | Как | Доступ |
|---|---|---|
| **Локально у разработчика** | `BITRIX_PATH` указывает на локальную копию Bitrix, nginx не нужен | `http://127.0.0.1:3100` |
| **На сервере с Bitrix** | как в HOWTO, сервис слушает `127.0.0.1:3100` | только с сервера |
| **Публично** | nginx + TLS, проксирование на `127.0.0.1:3100` | по вашему домену |

Публичный вариант — это просто nginx перед тем же сервисом. Готовый конфиг —
[`src/nginx-camouf.ru.conf`](src/nginx-camouf.ru.conf), в нём нужно заменить домен.

> Если выставляете сервер наружу, помните: аутентификации в нём нет. Ограничьте доступ
> на уровне nginx (allow/deny, basic auth) или не публикуйте его вообще.

## Инструменты (24 шт.)

### Модули и структура

| Инструмент | Что делает |
|---|---|
| `liveApiListModules` | Список установленных модулей Bitrix с версиями |
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
| `liveApiFindFunction` | Поиск функции/метода по имени во всех модулях |
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

Транспорт: **Streamable HTTP** (MCP spec 2025-03-26), stateless — клиенту не нужны
`initialize` и `Mcp-Session-Id`. Сервер читает PHP-файлы ядра Bitrix напрямую, поэтому
индексы всегда соответствуют вашей версии.

### EmbeddingGemma 2

Семантический поиск работает на **`google/embeddinggemma-2`** (Apache 2.0, text-only
бэкбон 270M, fp32, 256-мерные векторы через Matryoshka-усечение).

Сервис эмбеддингов один, а потребителей может быть несколько: профиль задаёт
обязательный для этой модели task-префикс и размерность.

| Профиль | Префикс | Назначение |
|---|---|---|
| `docs_query` | `task: search result \| query: ` | запросы `searchDocs` |
| `docs_passage` | `title: none \| text: ` | индексация документации |
| `site_query` / `site_passage` | те же | индекс контента сайта (если подключаете) |
| `code_query` | `task: code retrieval \| query: ` | поиск по коду |
| `generic` | без префикса | служебное |

Индексация документации инкрементальная: неизменные чанки не пересчитываются.
Подробности, замеры и настройка — в [HOWTO.md](HOWTO.md).

## Проверка

```bash
curl -s http://127.0.0.1:3100/health | jq .          # версия, модель, подпись индекса
curl -s http://127.0.0.1:8000/health | jq .          # сервис эмбеддингов

curl -s -X POST http://127.0.0.1:3100/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"liveApiListModules","arguments":{}},"id":1}' \
  | jq -r .result.content[0].text
```

## Подключение клиентов

Замените адрес на свой: `http://127.0.0.1:3100` для локальной установки или
`https://mcp.example.com` для публичной.

```json
{
  "mcpServers": {
    "bitrix": {
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

Если клиент не поддерживает `url`:

```json
{
  "mcpServers": {
    "bitrix": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:3100"]
    }
  }
}
```

Где это лежит: Cursor — `.cursor/mcp.json`, Claude Desktop —
`claude_desktop_config.json`, PhpStorm — `/.ai/mcp/mcp.json`.

## Обслуживание

| Задача | Как |
|---|---|
| Обновить индекс после обновления Bitrix | `POST /admin/reindex` (cron делает это сам) |
| Обновить документацию | `POST /admin/reindex-docs` (инкрементально) |
| Сменить модель эмбеддингов | `EMBEDDING_MODEL`/`EMBEDDING_DIM` + переиндексация |
| Подключить второго потребителя | профиль в `src/python/embeddings-service.py` |

Прогресс любой индексации — `GET /admin/progress`.

## Документация

- [HOWTO.md](HOWTO.md) — развёртывание с нуля, требования, cron, обслуживание
- [PUBLIC_BITRIX_MCP.md](PUBLIC_BITRIX_MCP.md) — архитектура и схема БД
- [BITRIX24_MCP.md](BITRIX24_MCP.md) — ТЗ на MCP-сервер для Битрикс24

## Лицензия

[MIT](LICENSE)
