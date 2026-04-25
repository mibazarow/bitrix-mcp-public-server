# MCP-сервер для Битрикс24 — Техническое задание

## 1. Цель

Разработать MCP-сервер для AI-агентов (Cursor, Claude Desktop, PhpStorm, Kilo), предоставляющий справочную информацию по разработке **Битрикс24** (далее — Б24) в двух редакциях:

| Редакция | Тип доступа | Подход |
|----------|-------------|--------|
| **Коробочная (self-hosted)** | PHP-ядро на сервере | LiveAPI (регекс-парсинг PHP-файлов) + документация |
| **Облачная (SaaS)** | REST API + вебхуки | REST-документация + API-прокси + webhook handler |

---

## 2. Исходные данные (существующий проект BUS MCP)

Проект `bxmcp` для 1С-Битрикс: Управление сайтом (далее — BUS):
- Node.js/TypeScript, `@modelcontextprotocol/sdk` v1.29
- Транспорт: Streamable HTTP (MCP spec 2025-03-26)
- `Express` на порту 3100, nginx-прокси с rate limiting
- SQLite (`better-sqlite3`) — индекс функций, классов, событий, чанков документации
- Python-сервис embeddings (`sentence-transformers intfloat/multilingual-e5-small`)
- systemd: `bxmcp` + `bxmcp-embeddings`
- Cron: автоиндексация (ежечасно) + обновление docs (ежедневно)

**Схема БД:**
```
modules    — id, name, version, path, indexed_at
functions  — name, module_id, file_path, line_number, phpdoc, code, args, is_method, class_name, visibility
events     — name, module_id, file_path, line_number, fired_in_function
classes    — name, module_id, file_path, line_number, type, extends, implements, phpdoc
doc_chunks — file_path, chunk_index, content, embedding BLOB
```

---

## 3. Варианты архитектуры

### Вариант A: Единый MCP-сервер с режимами (рекомендуется)

```
VDS
├── B24 Коробка (PHP, Apache/Nginx)
│   └── /var/www/bitrix24/bitrix/modules/
│
├── B24 MCP Server (Node.js, порт 3100)
│   ├── LiveAPI Service (коробка) — парсинг PHP, SQLite-индекс
│   ├── REST Docs Service (облако) — документация REST API
│   ├── REST Proxy (облако) — выполнение REST-запросов к порталу
│   ├── Webhook Receiver (облако) — приём событий от Б24
│   ├── Docs Service — markdown документация (git)
│   ├── Search Service — семантический поиск (embeddings)
│   └── SQLite — /opt/b24mcp/data/index.db
│
├── Embeddings Service (Python, FastAPI, порт 8000)
│
└── nginx — прокси:
    ├── b24mcp.example.com → localhost:3100 (MCP)
    └── example.com/mcp/ → localhost:3100 (через основной домен)
```

MCP-сервер определяет режим работы **на уровне инструментов**:
- Если доступен путь к PHP-ядру (`B24_CORE_PATH`) — регистрируются `liveApi*` инструменты
- Если не доступен — регистрируются `restApi*` и `restDocs*` инструменты
- Общие инструменты (`searchDocs`, `envInfo`) доступны всегда

### Вариант B: Два отдельных MCP-сервера

```
b24-box-mcp  — порт 3101, только для коробки (liveApi*)
b24-cloud-mcp — порт 3102, только для облака (restApi*)
```

> **Решение**: Выбран **Вариант A** — один сервер, который по наличию `B24_CORE_PATH` динамически регистрирует инструменты. Минимум дублирования кода, одна точка поддержки.

---

## 4. Инструменты MCP

### 4.1. Общие (для обеих редакций)

| Инструмент | Описание |
|-----------|----------|
| `searchDocs` | Семантический поиск по документации |
| `envInfo` | Информация об окружении (ОС, Node.js, PHP) |
| `b24GetEdition` | Возвращает `"box"`, `"cloud"` или `"unknown"` |
| `b24Reindex` | Переиндексация всех источников данных |

### 4.2. Коробочная версия (LiveAPI)

Полностью повторяют инструменты BUS MCP, адаптированные под структуру Б24:

| Инструмент | Описание |
|-----------|----------|
| `liveApiListModules` | Список модулей с версиями |
| `liveApiGetModuleFunctions` | Функции модуля (пагинация cursor) |
| `liveApiGetModuleEvents` | События модуля |
| `liveApiFindFunction` | Поиск функции по имени |
| `liveApiGetFunctionCode` | Код функции с PHPDoc |
| `liveApiFindByReflection` | Поиск по всему проекту |
| `liveApiGetModuleClasses` | Классы/интерфейсы/трейты модуля |

**Отличия от BUS:**
- Модули Б24: `crm`, `im`, `timeman`, `disk`, `bizproc`, `lists`, `report`, `voximplant`, `pull`, `rest` и др.
- Путь к ядру: `/var/www/bitrix24/bitrix/modules/`
- Инструмент `liveApiGetModuleClasses` — новый, детальная информация о классах

### 4.3. Облачная версия (REST API)

| Инструмент | Описание |
|-----------|----------|
| `restApiListMethods` | Список всех REST-методов Б24 (категоризированно по модулям) |
| `restApiGetMethodInfo` | Описание метода: параметры, поля, пример ответа |
| `restApiExecute` | Выполнить REST-запрос к порталу (требуется webhook URL) |
| `restApiListScopes` | Список доступных scope (crm, tasks, im, ...) |
| `restApiSearchMethod` | Поиск REST-метода по имени/описанию |
| `restApiGetEntityFields` | Поля сущности CRM (лид, сделка, контакт, компания) |
| `restApiGetEvents` | Список вебхук-событий Б24 |

#### `restApiExecute` — детали

```typescript
// Параметры
{
  webhookUrl: string;       // https://portal.bitrix24.ru/rest/1/xxx/
  method: string;           // crm.lead.list
  params?: Record<string, any>; // тело запроса
}

// Выполнение: HTTP POST к {webhookUrl}{method}.json
// Ответ: проксируется как есть
```

> **Безопасность**: `webhookUrl` передаётся клиентом при каждом вызове. Сервер **не хранит** токены доступа. Rate limit на клиента (100 запросов/мин/IP).

#### `restApiGetMethodInfo` — источник данных

Документация REST API загружается из репозитория:

```bash
git clone --depth 1 https://github.com/bitrix-tools/rest-api-docs.git /opt/b24mcp/data/rest-docs
```

Либо при отсутствии репозитория — парсинг https://apidocs.bitrix24.ru/ с кешированием в SQLite.

---

## 5. REST-документация

### 5.1. Источники

1. **Официальная документация** — https://apidocs.bitrix24.ru/
2. **Репозиторий с markdown** — `bitrix-tools/rest-api-docs` (зеркало apidocs в формате .md)
3. **OpenAPI/Swagger-спецификация** — Б24 предоставляет OpenAPI-схему для REST методов

### 5.2. Приоритетный способ

Использовать репозиторий markdown (аналогично `framework-docs` для BUS):
- `git clone --depth 1 https://github.com/bitrix-tools/rest-api-docs.git`
- Структура: `modules/{scope}/{method}.md`
- Embeddings-индексация: те же чанки → embedding → `doc_chunks`
- MCP resources: `b24-docs://rest/{scope}/{method}`

### 5.3. Структура страницы REST-метода

```markdown
# crm.lead.list

## Scope
crm

## HTTP
POST /rest/crm.lead.list.json

## Параметры
| Параметр | Тип | Обязательный | Описание |
|----------|-----|-------------|----------|
| order | object | Нет | Сортировка |
| filter | object | Нет | Фильтр |
| select | array | Нет | Выбираемые поля |
| start | integer | Нет | Смещение (пагинация) |

## Поля сущности
| Поле | Тип | Описание |
|------|-----|----------|
| ID | integer | Идентификатор |
| TITLE | string | Название |
| NAME | string | Имя |
| ... | ... | ... |

## Пример ответа
```json
{
  "result": [...],
  "total": 150,
  "next": 50
}
```

## Примеры
\```php
// PHP через REST
$result = CRest::call('crm.lead.list', [
  'filter' => { 'STATUS_ID': 'NEW' },
  'select' => ['ID', 'TITLE', 'NAME']
]);
\```
```

---

## 6. Webhook Receiver

Для облачной версии необходим endpoint для приёма исходящих вебхуков Б24.

### 6.1. Как работает

1. На портале Б24 создаётся исходящий вебхук (CRM-события, задачи и т.д.)
2. Б24 отправляет POST на `https://b24mcp.example.com/webhook`
3. MCP-сервер принимает событие, логирует, опционально сохраняет в SQLite
4. Клиент может запросить историю событий через инструмент `restApiGetWebhookLog`

### 6.2. Инструменты

| Инструмент | Описание |
|-----------|----------|
| `restApiGetWebhookLog` | История принятых вебхуков (с пагинацией) |
| `restApiRegisterWebhook` | Сгенерировать URL для вебхука (возвращает `{url: "https://..."}`) |

### 6.3. Схема БД для вебхуков

```sql
CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name TEXT NOT NULL,       -- ONCRMLEADADD, ONTASKADD и т.д.
  payload TEXT NOT NULL,          -- JSON-тело запроса
  received_at TEXT NOT NULL,      -- datetime('now')
  portal_id TEXT,                 -- домен портала (из заголовка)
  auth_id TEXT                    -- auth_id из запроса (не хранить секреты долго)
);
```

---

## 7. Документация (markdown)

### 7.1. Источники документации

| Источник | Редакция | Формат | Описание |
|----------|----------|--------|----------|
| `bitrix-tools/framework-docs` | Коробка | .md | Документация Bitrix Framework |
| `bitrix-tools/rest-api-docs` | Облако | .md | REST-методы Б24 |
| `bitrix-tools/b24-admin-docs` | Обе | .md | Администрирование Б24 |
| `bitrix-tools/b24-marketplace-docs` | Обе | .md | Разработка приложений для Marketplace |

### 7.2. MCP Resources

```
b24-docs://list                   — дерево документации
b24-docs://framework/{path}       — документация Bitrix Framework
b24-docs://rest/{scope}/{method}  — REST-метод Б24
b24-docs://admin/{path}           — администрирование
b24-docs://marketplace/{path}     — разработка приложений
```

---

## 8. Компоненты системы

### 8.1. MCP-сервер (TypeScript)

```
/opt/b24mcp/
├── src/
│   ├── index.ts                    # точка входа, Express + StreamableHTTP
│   ├── liveapi/                    # === Коробочная версия ===
│   │   ├── indexer.ts              # обход PHP-файлов, парсинг
│   │   ├── storage.ts              # SQLite: запись/чтение
│   │   └── tools.ts                # инструменты LiveAPI
│   ├── restapi/                    # === Облачная версия ===
│   │   ├── docs-indexer.ts         # индексация REST-документации
│   │   ├── executor.ts             # HTTP-прокси для REST-запросов к порталу
│   │   ├── webhook.ts              # приём и хранение вебхуков
│   │   └── tools.ts                # инструменты REST API
│   ├── docs/
│   │   ├── service.ts              # работа с markdown (переиспользуется из BUS)
│   │   └── resources.ts            # MCP resources (расширенная схема)
│   ├── search/
│   │   ├── embeddings.ts           # HTTP-клиент к Python-сервису
│   │   └── service.ts              # поиск по embeddings
│   └── utils/
│       ├── php-parser.ts           # regex-парсер PHP (переиспользуется)
│       └── config.ts               # конфигурация
├── package.json / tsconfig.json
├── dist/
├── data/
│   ├── framework-docs/             # git clone framework-docs (коробка)
│   ├── rest-docs/                  # git clone rest-api-docs (облако)
│   └── index.db                    # SQLite
├── scripts/
│   ├── reindex.sh                  # cron: каждый час
│   └── update-docs.sh              # cron: ежедневно в 3:00
└── python/
    └── embeddings-service.py       # FastAPI (переиспользуется)
```

### 8.2. Embeddings-сервис (Python)

Идентичен BUS-версии. Переиспользуется без изменений.

---

## 9. Детальная реализация компонентов

### 9.1. `src/index.ts` — точка входа

```typescript
// Определение режима при старте
const isBox = existsSync(CONFIG.b24CorePath);
const edition: 'box' | 'cloud' = isBox ? 'box' : 'cloud';

// Регистрация инструментов в зависимости от режима
if (edition === 'box') {
  initLiveApi();  // парсинг PHP, регистрация liveApi* инструментов
} else {
  initRestApi();  // загрузка REST-документации, регистрация restApi* инструментов
}
```

### 9.2. Dynamic tool registration

```typescript
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [...commonTools];

  if (edition === 'box') {
    tools.push(...liveApiTools);
  } else {
    tools.push(...restApiTools);
  }

  return { tools };
});
```

### 9.3. REST executor (`src/restapi/executor.ts`)

```typescript
export async function executeRestCall(
  webhookUrl: string,
  method: string,
  params: Record<string, any>
): Promise<any> {
  const url = `${webhookUrl.replace(/\/$/, '')}/${method}.json`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30000),
  });
  return response.json();
}
```

### 9.4. Webhook handler (`src/restapi/webhook.ts`)

```typescript
app.post('/webhook', async (req, res) => {
  const event = req.body?.event || req.headers['x-bitrix-event'];
  const payload = JSON.stringify(req.body);

  // Сохраняем в БД
  db.prepare(
    `INSERT INTO webhook_events (event_name, payload, received_at, portal_id)
     VALUES (?, ?, datetime('now'), ?)`
  ).run(event || 'unknown', payload, req.body?.auth?.domain || null);

  res.json({ status: 'ok' });
});
```

---

## 10. Расширение схемы SQLite

```sql
-- Дополнительные таблицы для Б24

-- REST-методы (облако)
CREATE TABLE rest_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,        -- crm.lead.list
  scope TEXT NOT NULL,              -- crm
  description TEXT,
  http_method TEXT DEFAULT 'POST',
  endpoint TEXT,
  params_schema TEXT,              -- JSON Schema параметров
  fields_schema TEXT,              -- JSON Schema полей сущности
  example_response TEXT,
  doc_path TEXT                    -- путь к markdown файлу
);

-- Вебхуки (облако)
CREATE TABLE webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_name TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  portal_id TEXT,
  auth_id TEXT
);

-- Индексы
CREATE INDEX idx_rest_methods_scope ON rest_methods(scope);
CREATE INDEX idx_rest_methods_name ON rest_methods(name);
CREATE INDEX idx_webhook_events_event ON webhook_events(event_name);
CREATE INDEX idx_webhook_events_received ON webhook_events(received_at);
```

---

## 11. Инфраструктура

### 11.1. nginx

```nginx
# /etc/nginx/conf.d/ratelimit.conf
limit_req_zone $binary_remote_addr zone=b24mcp:10m rate=10r/s;

# /etc/nginx/sites-enabled/b24mcp.conf

# Поддомен для MCP
server {
    listen 443 ssl;
    server_name b24mcp.example.com;
    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
        proxy_buffering off;
        proxy_cache off;
        limit_req zone=b24mcp burst=20 nodelay;
    }

    location /embed/ {
        rewrite ^/embed(/.*)$ $1 break;
        proxy_pass http://127.0.0.1:8000;
    }
}

# Если Б24 коробка на том же сервере — MCP через /mcp/
server {
    listen 443 ssl;
    server_name example.com;  # основной домен Б24
    # ... Bitrix24 конфиг ...

    location /mcp/ {
        rewrite ^/mcp(/.*)$ $1 break;
        proxy_pass http://127.0.0.1:3100;
        # ... те же proxy настройки ...
    }

    location /webhook/ {
        rewrite ^/webhook(/.*)$ $1 break;
        proxy_pass http://127.0.0.1:3100;
    }
}
```

### 11.2. systemd

**b24mcp.service:**
```ini
[Unit]
Description=B24 MCP Server
After=network.target b24mcp-embeddings.service
Requires=b24mcp-embeddings.service

[Service]
User=bitrix
Group=bitrix
WorkingDirectory=/opt/b24mcp
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=B24_CORE_PATH=/var/www/bitrix24/bitrix/modules
Environment=B24_EDITION=auto
Environment=EMBEDDINGS_URL=http://127.0.0.1:8000
Environment=PORT=3100
Environment=DB_PATH=/opt/b24mcp/data/index.db

[Install]
WantedBy=multi-user.target
```

**b24mcp-embeddings.service:**
```ini
[Unit]
Description=B24 MCP Embeddings Service
After=network.target

[Service]
User=bitrix
Group=bitrix
WorkingDirectory=/opt/b24mcp/python
ExecStart=/opt/b24mcp/python/venv/bin/python -m uvicorn embeddings-service:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 11.3. Переменные окружения

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `B24_CORE_PATH` | `/var/www/bitrix24/bitrix/modules` | Путь к PHP-ядру Б24 (коробка) |
| `B24_EDITION` | `auto` | `auto` / `box` / `cloud` |
| `REST_DOCS_PATH` | `/opt/b24mcp/data/rest-docs` | Путь к REST-документации |
| `FRAMEWORK_DOCS_PATH` | `/opt/b24mcp/data/framework-docs` | Путь к документации Framework |
| `PORT` | `3100` | Порт MCP-сервера |
| `EMBEDDINGS_URL` | `http://127.0.0.1:8000` | URL Python-сервиса embeddings |
| `DB_PATH` | `/opt/b24mcp/data/index.db` | Путь к SQLite |
| `WEBHOOK_PATH` | `/webhook` | Путь для приёма вебхуков |

### 11.4. Cron

```bash
# /etc/cron.d/b24mcp
0 * * * * bitrix /opt/b24mcp/scripts/reindex.sh           # каждый час
0 3 * * * bitrix /opt/b24mcp/scripts/update-docs.sh       # ежедневно в 3:00
*/5 * * * * bitrix /opt/b24mcp/scripts/clean-webhooks.sh  # чистка вебхуков старше 7 дней
```

---

## 12. План разработки

### Этап 1: База (1-2 дня)

- [ ] Форкнуть/скопировать `bxmcp` → `b24mcp`
- [ ] Переименовать конфиги, переменные, namespace
- [ ] Добавить `B24_CORE_PATH` и `B24_EDITION` в конфиг
- [ ] Реализовать `b24GetEdition` — определение редакции
- [ ] Адаптировать пути для типовой установки Б24 коробки

### Этап 2: Коробочная версия (2-3 дня)

- [ ] Протестировать LiveAPI на ПУБ-ядре Б24 (модули: crm, im, disk, timeman, bizproc)
- [ ] Добавить `liveApiGetModuleClasses` — детальный список классов модуля
- [ ] Проверить индексацию на реальной коробке Б24
- [ ] Адаптировать php-parser под особенности кода Б24 (неймспейсы, трейты)

### Этап 3: REST-документация (2-3 дня)

- [ ] Создать `rest-api-docs` репозиторий (зеркало apidocs)
- [ ] Индексатор: парсинг markdown → SQLite
- [ ] `restApiListMethods` + `restApiGetMethodInfo`
- [ ] `restApiSearchMethod` — поиск по названиям и описаниям
- [ ] `restApiGetEntityFields` — поля CRM-сущностей
- [ ] MCP resources: `b24-docs://rest/{scope}/{method}`

### Этап 4: REST-executor + webhooks (2-3 дня)

- [ ] `restApiExecute` — прокси-запросы к порталу
- [ ] Валидация webhook URL (формат, доступность)
- [ ] Webhook endpoint: приём, валидация, сохранение
- [ ] `restApiGetWebhookLog` — история вебхуков
- [ ] Таблица `webhook_events`, автоочистка старого

### Этап 5: Инфраструктура (1-2 дня)

- [ ] nginx-конфиг для `b24mcp.example.com`
- [ ] systemd-юниты (`b24mcp`, `b24mcp-embeddings`)
- [ ] Скрипты: reindex.sh, update-docs.sh, clean-webhooks.sh
- [ ] Cron-задачи
- [ ] fail2ban, rate limiting
- [ ] Логирование (pino), graceful shutdown

### Этап 6: Тестирование и документация (1-2 дня)

- [ ] Проверка на коробочной версии Б24
- [ ] Проверка на облачной версии (через REST)
- [ ] README с инструкциями подключения
- [ ] Тест-кейсы для каждого инструмента

---

## 13. Критерии приёмки

1. **MCP-сервер запускается** на чистой Ubuntu 22.04/24.04 без ручной правки кода
2. **Автоопределение редакции**: `b24GetEdition` возвращает корректное значение
3. **Коробка**: все `liveApi*` инструменты работают, индексируется минимум 40 модулей
4. **Облако**: все `restApi*` инструменты работают, минимум 500 REST-методов в индексе
5. **REST-executor**: `restApiExecute` с корректным webhook URL возвращает данные
6. **Вебхуки**: на `POST /webhook` приходит событие, сохраняется в БД, доступно через `restApiGetWebhookLog`
7. **Семантический поиск**: `searchDocs` возвращает релевантные результаты по REST API и Framework
8. **Производительность**: ответ на `tools/list` — не более 500 мс, `tools/call` — не более 3 с
9. **Безопасность**: MCP-сервер не хранит токены доступа к порталам; rate limit активен
10. **Надёжность**: после перезапуска сервера все сервисы стартуют автоматически

---

## 14. Отличия от BUS MCP (резюме)

| Характеристика | BUS MCP | B24 MCP |
|---------------|---------|---------|
| Редакции | Только коробка | Коробка + Облако |
| Источник кода | `bitrix/modules/` BUS | `bitrix/modules/` Б24 (коробка) |
| REST API | Нет | apidocs.bitrix24.ru + executor |
| Вебхуки | Нет | Приём и хранение событий Б24 |
| CRM | Косвенно (модуль sale) | Полноценно: leads, deals, contacts, companies, smart-processes |
| Инструментов | 9 | 15+ (зависит от редакции) |
| MCP resources | `bx-docs://` | `b24-docs://{framework,rest,admin,marketplace}/` |

---

## 15. Приложение: Полезные ссылки

- Официальная REST-документация: https://apidocs.bitrix24.ru/
- Bitrix Framework документация: https://docs.1c-bitrix.ru/
- Маркетплейс Б24: https://marketplace.bitrix24.ru/
- MCP SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP Specification 2025-03-26: https://spec.modelcontextprotocol.io/
- Репозиторий framework-docs: https://github.com/bitrix-tools/framework-docs
- sentence-transformers multilingual-e5-small: https://huggingface.co/intfloat/multilingual-e5-small
