# Bitrix MCP Server — Бэкап и инструкция по переносу

Версия: 1.0.0 | Дата бэкапа: 27.04.2026

## Обзор

MCP-сервер для AI-агентов, предоставляющий справочную информацию по Bitrix Framework через LiveAPI и семантический поиск по документации.

Состоит из трёх компонентов:
1. **MCP Server (Node.js/TypeScript)** — порт 3100
2. **Embeddings Service (Python/FastAPI)** — порт 8000 (только 127.0.0.1)
3. **nginx** — обратный прокси с SSL на вашем домене (например, `bxmcp.example.com`)

---

## Структура архива

```
MCP_SERVER_BACAP/
├── README.md                     ← этот файл
├── README-server.md              ← оригинальный README сервера
├── package.json                  ← Node.js зависимости
├── package-lock.json
├── tsconfig.json                 ← TypeScript конфигурация
├── .gitignore
├── src/                          ← исходный код
│   ├── index.ts                  ← точка входа MCP-сервера
│   ├── utils/
│   │   ├── config.ts             ← конфигурация (пути, порты)
│   │   └── php-parser.ts         ← парсер PHP-файлов Bitrix
│   ├── liveapi/
│   │   ├── indexer.ts            ← индексация модулей/компонентов
│   │   ├── storage.ts            ← SQLite БД + кэш эмбеддингов
│   │   └── tools.ts              ← все MCP-инструменты
│   ├── search/
│   │   ├── service.ts            ← семантический поиск
│   │   └── embeddings.ts         ← вызов Embeddings API
│   └── docs/
│       ├── resources.ts          ← MCP Resources (bx-docs://)
│       └── service.ts            ← работа с файлами документации
├── python/
│   ├── embeddings-service.py     ← FastAPI сервис эмбеддингов
│   └── requirements.txt          ← Python зависимости
├── scripts/
│   ├── reindex.sh                ← cron: проверка изменений PHP
│   └── update-docs.sh            ← cron: обновление документации
├── systemd/
│   ├── bxmcp.service             ← systemd unit для MCP-сервера
│   └── bxmcp-embeddings.service  ← systemd unit для Embeddings
├── nginx/
│   └── nginx-bxmcp.conf          ← конфигурация nginx (серверный блок)
└── bin/
    └── bxmcp-node                ← wrapper для запуска Node.js
```

---

## Инструкция по переносу на новую машину

### Требования

- **ОС:** Ubuntu 22.04/24.04 или Debian 12
- **Node.js:** v22+ (рекомендуется через nvm)
- **Python:** 3.12+
- **nginx** + Let's Encrypt (certbot)
- **Git** (для клонирования документации)
- **PHP** (опционально, для `envInfo`)

### Шаг 1: Установка Node.js

```bash
# Установка nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc

# Установка Node.js v22
nvm install 22
nvm use 22

# Проверка
node --version   # должно быть v22.x.x
```

### Шаг 2: Установка Python и создание venv

```bash
apt install -y python3.12 python3.12-venv python3-pip

# Создание виртуального окружения
python3.12 -m venv /opt/bitrix-mcp/python/venv

# Активация и установка пакетов
source /opt/bitrix-mcp/python/venv/bin/activate
pip install -r python/requirements.txt
```

**Важно:** sentence-transformers при первом запуске скачает модель `intfloat/multilingual-e5-small` (~470 MB). Убедитесь, что есть доступ к huggingface.co или настройте зеркало (см. раздел «Замечания»).

### Шаг 3: Размещение файлов

```bash
# Скопируйте всю папку MCP_SERVER_BACAP на сервер
# Например, в /opt/bitrix-mcp/

cp -r MCP_SERVER_BACAP/* /opt/bitrix-mcp/
```

### Шаг 4: Сборка TypeScript

```bash
cd /opt/bitrix-mcp
npm install
npm run build   # tsc -> dist/
```

### Шаг 5: Настройка конфигурации (config.ts)

Отредактируйте `/opt/bitrix-mcp/src/utils/config.ts` или задайте переменные окружения:

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `BITRIX_PATH` | `/var/www/SITE.ru/bitrix/modules` | Путь к папке modules Bitrix |
| `COMPONENTS_PATH` | `/var/www/SITE.ru/bitrix/components` | Путь к папке components |
| `DB_PATH` | `/opt/bitrix-mcp/data/index.db` | Путь к SQLite БД |
| `DOCS_PATH` | `/opt/bitrix-mcp/data/docs` | Путь к документации |
| `EMBEDDINGS_URL` | `http://127.0.0.1:8000` | URL Embeddings сервиса |
| `PORT` | `3100` | Порт MCP-сервера |

После изменения `config.ts` пересоберите: `npm run build`

### Шаг 6: Создание системных пользователей и директорий

```bash
# Создание директорий
mkdir -p /opt/bitrix-mcp/data/docs

# Если нужен отдельный пользователь:
useradd -r -s /bin/false bitrix
chown -R bitrix:bitrix /opt/bitrix-mcp/data
```

### Шаг 7: Установка systemd-сервисов

```bash
cp systemd/bxmcp.service /etc/systemd/system/
cp systemd/bxmcp-embeddings.service /etc/systemd/system/

# Если пользователь не bitrix, отредактируйте User/Group в сервисах
# По умолчанию сервисы запускаются от root

systemctl daemon-reload
systemctl enable bxmcp-embeddings.service bxmcp.service
systemctl start bxmcp-embeddings.service
sleep 5   # подождать загрузку модели
systemctl start bxmcp.service

# Проверка
systemctl status bxmcp.service bxmcp-embeddings.service
```

### Шаг 8: Установка wrapper-скрипта для Node.js

```bash
cp bin/bxmcp-node /usr/local/bin/bxmcp-node
chmod +x /usr/local/bin/bxmcp-node

# ВАЖНО: отредактируйте путь к node в скрипте, если версия отличается:
# exec /path/to/nvm/versions/node/v22.x.x/bin/node "$@"
```

### Шаг 9: Настройка nginx

1. Скопируйте конфигурацию nginx:

```bash
cp nginx/nginx-bxmcp.conf /etc/nginx/sites-available/bxmcp.conf

# Отредактируйте server_name на ваш домен
# Например: server_name bxmcp.YOUR-DOMAIN.ru;

ln -s /etc/nginx/sites-available/bxmcp.conf /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

2. Получите SSL-сертификат:

```bash
certbot --nginx -d bxmcp.YOUR-DOMAIN.ru
```

3. Откройте порты в файерволе (если используется):

```bash
ufw allow 80/tcp
ufw allow 443/tcp
```

Порт 3100 не нужно открывать наружу — доступ только через nginx.

### Шаг 10: Клонирование документации

```bash
cd /opt/bitrix-mcp/data
git clone --depth 1 https://github.com/bitrix-tools/framework-docs.git docs
```

### Шаг 11: Первичная индексация

После того как оба сервиса запущены:

```bash
# Индексация модулей и компонентов Bitrix
curl -X POST http://127.0.0.1:3100/admin/reindex

# Индексация документации (требует работающий Embeddings сервис)
curl -X POST http://127.0.0.1:3100/admin/reindex-docs

# Проверка прогресса
curl http://127.0.0.1:3100/admin/progress

# Health check
curl http://127.0.0.1:3100/health
curl http://127.0.0.1:8000/health
```

### Шаг 12: Настройка cron

```bash
# В crontab (crontab -e):
# Проверка изменений PHP-файлов каждый час
0 * * * * /opt/bitrix-mcp/scripts/reindex.sh >> /var/log/bxmcp-reindex.log 2>&1

# Обновление документации ежедневно в 3:00
0 3 * * * /opt/bitrix-mcp/scripts/update-docs.sh >> /var/log/bxmcp-docs.log 2>&1
```

### Шаг 13: Проверка работоспособности

```bash
# Прямой health-check MCP-сервера
curl http://127.0.0.1:3100/health
# Ответ: {"status":"ok","uptime":...}

# Health-check Embeddings
curl http://127.0.0.1:8000/health
# Ответ: {"status":"ok"}

# Проверка SSE (MCP протокол)
curl -s -N -H "Accept: text/event-stream" http://127.0.0.1:3100/sse

# Публичный health-check через nginx
curl https://bxmcp.YOUR-DOMAIN.ru/health
```

---

## Подключение клиентов

### Kilo

Добавить в `~/.config/kilo/kilo.jsonc`:

```json
{
  "mcpServers": {
    "bitrix": {
      "type": "sse",
      "url": "https://bxmcp.YOUR-DOMAIN.ru/sse"
    }
  }
}
```

### Cursor / VSCode (`mcp.json`)

```json
{
  "mcpServers": {
    "bitrix": {
      "command": "npx",
      "args": ["mcp-remote", "https://bxmcp.YOUR-DOMAIN.ru"]
    }
  }
}
```

### PhpStorm (`/.ai/mcp/mcp.json`)

```json
{
  "mcpServers": {
    "bitrix": {
      "command": "npx",
      "args": ["mcp-remote", "https://bxmcp.YOUR-DOMAIN.ru"]
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
      "args": ["mcp-remote", "https://bxmcp.YOUR-DOMAIN.ru"]
    }
  }
}
```

---

## Доступные MCP-инструменты

| Инструмент | Описание |
|-----------|----------|
| `liveApiListModules` | Список установленных модулей с версиями |
| `liveApiListComponents` | Список компонентов Bitrix |
| `liveApiGetModuleFunctions` | Функции модуля (с курсорной пагинацией) |
| `liveApiGetModuleClasses` | Классы модуля (с пагинацией) |
| `liveApiGetModuleEvents` | События модуля |
| `liveApiFindFunction` | Поиск функции/метода по имени |
| `liveApiGetFunctionCode` | Полный код функции с PHPDoc |
| `liveApiFindByReflection` | Reflection-поиск с опциональным возвратом кода |
| `liveApiFindByNamespace` | Поиск классов/функций по namespace |
| `liveApiGetClassCode` | Путь к файлу класса и PHPDoc |
| `liveApiGetClassMethods` | Все методы класса с сигнатурами |
| `liveApiGetClassConstants` | Константы класса |
| `liveApiGetClassConstantValue` | Значение конкретной константы |
| `liveApiGetClassHierarchy` | Наследование класса |
| `liveApiFindByInterface` | Поиск классов, реализующих интерфейс |
| `liveApiGetAllEvents` | Все события по всем модулям |
| `liveApiGetEventHandler` | Обработчики конкретного события |
| `liveApiGetModuleStructure` | Структура файлов модуля |
| `liveApiGetFunctionUsage` | Где используется функция |
| `liveApiListDataManagers` | DataManager ORM-классы |
| `liveApiGetEntityFields` | Поля ORM-сущности (парсинг getMap()) |
| `liveApiGetDocResource` | Содержимое файла документации |
| `searchDocs` | Семантический поиск по документации |
| `envInfo` | Информация об окружении (OS, PHP, модули) |

---

## MCP Resources

- `bx-docs://list` — дерево файлов документации
- `bx-docs://{path}` — содержимое конкретного `.md` файла

---

## Админ-эндпоинты

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/health` | Health-check |
| `POST` | `/admin/reindex` | Полная переиндексация (модули + компоненты) |
| `POST` | `/admin/reindex-components` | Переиндексация компонентов |
| `POST` | `/admin/reindex-docs` | Переиндексация документации |
| `GET` | `/admin/progress` | Прогресс текущей индексации |

---

## Замечания

### Модель эмбеддингов

Используется `intfloat/multilingual-e5-small` (~470 MB). При первом запуске Embeddings Service:
- Модель загружается с HuggingFace Hub в кэш `~/.cache/huggingface/`
- Процесс использует ~1.3 GB RAM после загрузки
- Время первой загрузки: 30-120 секунд в зависимости от интернета

Если на сервере нет доступа к huggingface.co, используйте зеркало:
```bash
export HF_ENDPOINT=https://hf-mirror.com
```

### Размер индекса

- SQLite БД (`index.db`) после полной индексации: ~400 MB
- Документация (`data/docs/`): ~50 MB (git clone)

### Производительность

- **Embeddings Service:** 1.3 GB RAM, GPU не обязателен (работает на CPU)
- **MCP Server:** ~80 MB RAM
- **Общий минимум RAM:** 2 GB (рекомендуется 4 GB)

### Логи

```bash
# MCP Server
journalctl -u bxmcp.service -f

# Embeddings Service
journalctl -u bxmcp-embeddings.service -f
```

---

## Устранение неполадок

1. **MCP Server не запускается:**
   - Проверьте `node --version` (нужна v22+)
   - Проверьте, что `dist/` собран: `npm run build`
   - Проверьте права на `/opt/bitrix-mcp/data/`

2. **Embeddings не работают:**
   - Проверьте, что Python venv создан и пакеты установлены
   - Проверьте доступ к huggingface.co для загрузки модели
   - `journalctl -u bxmcp-embeddings.service -n 50`

3. **Реиндексация не запускается:**
   - Проверьте, что путь `BITRIX_PATH` указывает на существующую папку с модулями
   - Убедитесь, что Embeddings-сервис работает: `curl http://127.0.0.1:8000/health`

4. **SSL-сертификат:**
   - `certbot renew --dry-run` для проверки автообновления
   - Сертификаты в `/etc/letsencrypt/live/`

---

## Контакты

Оригинальный репозиторий: `/opt/bitrix-mcp/`
Документация Bitrix: https://github.com/bitrix-tools/framework-docs
