# План: Локальный BxMCP сервер

## Цель
Запустить MCP-сервер для 1С-Битрикс (`bxmcp`) локально на MacBook, без интернета.
Аналог `https://bxmcp.camouf.ru`, доступен по `http://bxmcp.local:3100`.

Вся установка: `/Users/mb/Documents/MCP/BITRIX/`

---

## 1. Структура

```
/Users/mb/Documents/MCP/BITRIX/
├── server/                   # Node.js сервер (скопирован из репозитория src/)
│   ├── package.json
│   ├── tsconfig.json
│   ├── dist/                 # скомпилированный JS
│   ├── index.ts
│   ├── liveapi/
│   ├── docs/
│   ├── search/
│   ├── python/               # FastAPI сервис embeddings
│   └── utils/
├── data/
│   ├── index.db              # SQLite база (индекс PHP-файлов)
│   └── docs/                 # клон https://github.com/bitrix-tools/framework-docs.git
└── python-venv/              # виртуальное окружение Python для embeddings
```

---

## 2. Компоненты

### 2.1 Node.js сервер (MCP)
- **Порт:** 3100
- **Транспорт:** Streamable HTTP (Express)
- **Инструменты:** `liveApiListModules`, `liveApiFindFunction`, `liveApiGetClassCode` и др. (21 шт.)
- **Ресурсы:** `bx-docs://` — чтение markdown документации

### 2.2 SQLite база (индекс)
- `data/index.db`
- Хранит: функции, классы, события, константы, usages, doc_chunks

### 2.3 Python embeddings сервис
- Нужен для `searchDocs` (семантический поиск по документации)
- Использует `sentence-transformers` (модель `intfloat/multilingual-e5-small`)
- Порт: 8000
- Если сервис недоступен — `searchDocs` вернёт пустой массив (без ошибки)

---

## 3. Установка

### 3.1 Создать директорию и скопировать сервер
```bash
mkdir -p /Users/mb/Documents/MCP/BITRIX/data
cp -r /Users/mb/Documents/TOOLS/bitrix-mcp-public-server/src /Users/mb/Documents/MCP/BITRIX/server
```

### 3.2 Пересобрать под ARM
```bash
cd /Users/mb/Documents/MCP/BITRIX/server
npm rebuild better-sqlite3
npm run build
```

### 3.3 Клонировать документацию
```bash
git clone --depth 1 https://github.com/bitrix-tools/framework-docs.git \
  /Users/mb/Documents/MCP/BITRIX/data/docs
```

### 3.4 Прописать bxmcp.local в hosts
```bash
echo "127.0.0.1 bxmcp.local" | sudo tee -a /etc/hosts
```
Проверка:
```bash
ping -c 1 bxmcp.local
```

### 3.5 Python embeddings
```bash
cd /Users/mb/Documents/MCP/BITRIX
python3 -m venv python-venv
source python-venv/bin/activate
pip install fastapi uvicorn sentence-transformers pydantic
```
Проверка:
```bash
uvicorn server.python.embeddings-service:app --host 127.0.0.1 --port 8000
# в другом окне:
curl http://127.0.0.1:8000/health
# {"status": "ok"}
```

---

## 4. Переменные окружения

Из `server/utils/config.ts`:

| Переменная | Значение |
|---|---|
| `BITRIX_PATH` | `/Users/mb/Documents/MAMP/bitrix.local/bitrix/modules` |
| `DB_PATH` | `/Users/mb/Documents/MCP/BITRIX/data/index.db` |
| `DOCS_PATH` | `/Users/mb/Documents/MCP/BITRIX/data/docs` |
| `PORT` | `3100` |
| `EMBEDDINGS_URL` | `http://127.0.0.1:8000` |

---

## 5. Запуск

### 5.1 Embeddings сервис
```bash
source /Users/mb/Documents/MCP/BITRIX/python-venv/bin/activate
uvicorn server.python.embeddings-service:app --host 127.0.0.1 --port 8000
```

### 5.2 MCP сервер (будет доступен на http://bxmcp.local:3100)
```bash
cd /Users/mb/Documents/MCP/BITRIX/server
BITRIX_PATH="/Users/mb/Documents/MAMP/bitrix.local/bitrix/modules" \
DB_PATH="/Users/mb/Documents/MCP/BITRIX/data/index.db" \
DOCS_PATH="/Users/mb/Documents/MCP/BITRIX/data/docs" \
PORT=3100 \
EMBEDDINGS_URL="http://127.0.0.1:8000" \
node dist/index.js
```

### 5.3 Индексация PHP
```bash
curl -X POST http://bxmcp.local:3100/admin/reindex
curl http://bxmcp.local:3100/admin/progress
# ждать {"isIndexing": false}

### 5.4 Индексация docs
```bash
curl -X POST http://bxmcp.local:3100/admin/reindex-docs
curl http://bxmcp.local:3100/admin/progress
# ждать {"isIndexing": false}
```

---

## 6. Подключение в Kilo

После запуска сервера — изменить `~/.config/kilo/kilo.jsonc`:

```jsonc
"mcp": {
  "bxmcp": {
    "type": "remote",
    "url": "http://bxmcp.local:3100",
    "enabled": true
  }
}
```

`type: "remote"` — потому что Kilo общается с сервером по HTTP, а не управляет процессом.

---

## 7. Автозапуск (launchd)

`~/Library/LaunchAgents/local.bxmcp.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>local.bxmcp</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/Users/mb/Documents/MCP/BITRIX/server/dist/index.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>BITRIX_PATH</key>
        <string>/Users/mb/Documents/MAMP/bitrix.local/bitrix/modules</string>
        <key>DB_PATH</key>
        <string>/Users/mb/Documents/MCP/BITRIX/data/index.db</string>
        <key>DOCS_PATH</key>
        <string>/Users/mb/Documents/MCP/BITRIX/data/docs</string>
        <key>PORT</key>
        <string>3100</string>
        <key>EMBEDDINGS_URL</key>
        <string>http://127.0.0.1:8000</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>/Users/mb/Documents/MCP/BITRIX/server</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

Установка:
```bash
launchctl load ~/Library/LaunchAgents/local.bxmcp.plist
launchctl start local.bxmcp
```

---

## 8. Проверка

```bash
# Health
curl http://bxmcp.local:3100/health

# Список инструментов
curl -s -X POST http://bxmcp.local:3100/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'

# Вызов инструмента
curl -s -X POST http://bxmcp.local:3100/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"liveApiListModules","arguments":{}},"id":2}'
```

---

## 9. Обновление индекса (после обновления Bitrix)

```bash
curl -X POST http://bxmcp.local:3100/admin/reindex
curl http://bxmcp.local:3100/admin/progress
```

---

## 10. Риски и нюансы

| Риск | Решение |
|---|---|
| `better-sqlite3` собран под Intel | `cd server && npm rebuild better-sqlite3` |
| Python embeddings тянет ~500 MB модели | Первый запуск `uvicorn` скачает модель |
| Документация git clone ~50 MB | Один раз, `--depth 1` |
| Kilo не может запускать HTTP-сервер через `local` | Используем `remote: http://bxmcp.local:3100` + launchd |
