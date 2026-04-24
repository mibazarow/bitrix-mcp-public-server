# HOWTO: Развёртывание BxMCP с нуля

## Требования к серверу

- Ubuntu 22.04/24.04 LTS
- 4 GB RAM, 2 vCPU, 20 GB SSD (рекомендуется)
- Node.js 18+ (через nvm)
- Python 3.10+
- nginx
- Установленный Bitrix CMS на том же сервере

---

## 1. Подготовка системы

```bash
apt update && apt upgrade -y
apt install -y nginx git python3 python3-venv python3-pip curl
```

## 2. Установка Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node --version  # должно быть v22+
```

## 3. Создание пользователя

```bash
useradd -r -s /bin/bash -d /opt/bitrix-mcp bitrix
mkdir -p /opt/bitrix-mcp
chown bitrix:bitrix /opt/bitrix-mcp
```

## 4. Клонирование проекта

```bash
cd /opt/bitrix-mcp
# скопировать содержимое src/ из этого репозитория
```

Либо вручную создать структуру:

```
/opt/bitrix-mcp/
├── src/
│   ├── index.ts
│   ├── liveapi/{indexer,storage,tools}.ts
│   ├── docs/{service,resources}.ts
│   ├── search/{embeddings,service}.ts
│   └── utils/{config,php-parser}.ts
├── python/embeddings-service.py
├── scripts/{reindex,update-docs}.sh
├── package.json
├── tsconfig.json
└── .gitignore
```

## 5. Установка зависимостей Node.js

```bash
cd /opt/bitrix-mcp
npm install
npx tsc
```

## 6. Python-сервис embeddings

```bash
cd /opt/bitrix-mcp/python
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn sentence-transformers pydantic
```

Проверка:

```bash
curl http://127.0.0.1:8000/health
# {"status": "ok"}
```

## 7. Документация (markdown)

```bash
mkdir -p /opt/bitrix-mcp/data
cd /opt/bitrix-mcp/data
git clone --depth 1 https://github.com/bitrix-tools/framework-docs.git docs
chown -R bitrix:bitrix /opt/bitrix-mcp/data
```

## 8. Индексация PHP-файлов Bitrix

Проверить путь к модулям Bitrix:

```bash
ls /home/bitrix/ext_www/camouf.ru/bitrix/modules/
```

Задать переменную окружения `BITRIX_PATH` (по умолчанию `/home/bitrix/ext_www/camouf.ru/bitrix/modules`).

Запустить первую индексацию:

```bash
curl -X POST http://127.0.0.1:3100/admin/reindex
curl http://127.0.0.1:3100/admin/progress
# {"isIndexing": false, "progress": "done: {\"modulesIndexed\":53,\"functionsIndexed\":...}"}
```

## 9. nginx

```nginx
# /etc/nginx/conf.d/ratelimit.conf
limit_req_zone $binary_remote_addr zone=mcp:10m rate=10r/s;

# /etc/nginx/sites-enabled/camouf.ru.conf

# Основной домен (Bitrix CMS) — MCP через /mcp/
server {
    listen 443 ssl;
    server_name camouf.ru;
    ssl_certificate /etc/letsencrypt/live/camouf.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/camouf.ru/privkey.pem;

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
}

# Поддомен bxmcp.camouf.ru — MCP в корне
server {
    listen 443 ssl;
    server_name bxmcp.camouf.ru;
    ssl_certificate /etc/letsencrypt/live/camouf.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/camouf.ru/privkey.pem;

    location / {
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
}

server {
    listen 80;
    server_name camouf.ru bxmcp.camouf.ru;
    return 301 https://$server_name$request_uri;
}
```

Проверка:

```bash
nginx -t
systemctl reload nginx
```

## 10. SSL (Let's Encrypt)

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d camouf.ru -d bxmcp.camouf.ru
```

## 11. systemd-сервисы

### bxmcp.service

```ini
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

### bxmcp-embeddings.service

```ini
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

Установка:

```bash
cp bxmcp.service bxmcp-embeddings.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bxmcp-embeddings
systemctl enable --now bxmcp
```

Проверка:

```bash
systemctl status bxmcp
systemctl status bxmcp-embeddings
journalctl -u bxmcp --no-pager -n 20
```

## 12. Cron

```bash
# /etc/cron.d/bxmcp
0 * * * * bitrix /opt/bitrix-mcp/scripts/reindex.sh        # каждый час
0 3 * * * bitrix /opt/bitrix-mcp/scripts/update-docs.sh    # ежедневно в 3:00
```

### reindex.sh

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

### update-docs.sh

```bash
#!/bin/bash
cd /opt/bitrix-mcp/data/docs
git pull --ff-only
curl -s -X POST http://127.0.0.1:3100/admin/reindex-docs
```

## 13. fail2ban

```bash
apt install -y fail2ban

# /etc/fail2ban/jail.local
[bxmcp]
enabled = true
port = http,https
filter = bxmcp
logpath = /var/log/nginx/access.log
maxretry = 10
findtime = 60
bantime = 3600

# /etc/filter.d/bxmcp.conf
[Definition]
failregex = ^<HOST> .* "(GET|POST) /mcp/.*" 40[0-9]
ignoreregex =
```

```bash
systemctl enable --now fail2ban
```

## 14. Индексация docs через embeddings

Инициализировать вручную (после запуска обоих сервисов):

```bash
curl -X POST http://127.0.0.1:3100/admin/reindex-docs
curl http://127.0.0.1:3100/admin/progress
# Дождаться {"isIndexing": false}
```

## 15. Проверка работоспособности

```bash
# Initialize
curl -s -X POST https://bxmcp.camouf.ru/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# tools/list (с sessionId из заголовка ответа)
curl -s -X POST https://bxmcp.camouf.ru/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Protocol-Version: 2025-03-26" \
  -H "Mcp-Session-Id: <SESSION_ID>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# tools/call
curl -s -X POST https://bxmcp.camouf.ru/mcp/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Protocol-Version: 2025-03-26" \
  -H "Mcp-Session-Id: <SESSION_ID>" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"liveApiListModules","arguments":{}}}'

# Health
curl https://bxmcp.camouf.ru/health
```

## 16. Подключение клиентов

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

---

## Структура репозитория

```
bxmcp/
├── PUBLIC_BITRIX_MCP.md          # архитектура проекта
├── README.md                     # быстрый старт для пользователей
├── HOWTO.md                      # этот файл — развёртывание с нуля
└── src/
    ├── index.ts                  # точка входа сервера
    ├── package.json
    ├── tsconfig.json
    ├── .gitignore
    ├── bxmcp.service             # systemd unit (MCP)
    ├── bxmcp-embeddings.service  # systemd unit (embeddings)
    ├── nginx-camouf.ru.conf      # nginx конфиг
    ├── nginx-ratelimit.conf      # rate limiting
    ├── cron-bxmcp                # расписание cron
    ├── liveapi/
    │   ├── indexer.ts            # индексация PHP-файлов
    │   ├── storage.ts            # SQLite storage
    │   └── tools.ts              # MCP инструменты LiveAPI
    ├── docs/
    │   ├── service.ts            # работа с markdown
    │   └── resources.ts          # MCP resources bx-docs://
    ├── search/
    │   ├── embeddings.ts         # клиент Python-сервиса
    │   └── service.ts            # семантический поиск
    ├── utils/
    │   ├── config.ts             # конфигурация (пути, порты)
    │   └── php-parser.ts         # regex-парсер PHP
    ├── python/
    │   └── embeddings-service.py # FastAPI сервис
    └── scripts/
        ├── reindex.sh            # автоиндексация (cron: час)
        └── update-docs.sh        # обновление docs (cron: день)
```
