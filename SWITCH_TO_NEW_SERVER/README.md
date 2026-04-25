# Перенос BxMCP на новый сервер

Миграция MCP-сервера для Bitrix Framework с минимальными усилиями.
Предполагается, что пользователь `bitrix` и сайт `camouf.ru` (Bitrix CMS) уже развёрнуты на новом сервере.

---

## Что в этом архиве

```
SWITCH_TO_NEW_SERVER/
├── README.md                 — этот файл
├── src/                      — исходный код TypeScript
├── dist/                     — скомпилированный JS (готов к запуску)
├── scripts/                  — cron-скрипты (reindex.sh, update-docs.sh)
├── embeddings-service.py     — Python-сервис embeddings (FastAPI)
├── package.json              — зависимости Node.js
├── package-lock.json
├── tsconfig.json             — конфиг TypeScript
└── .gitignore
```

Переезд один-в-один — все конфиги уже готовы. Править ничего не нужно.

Внутри `src/` лежат вспомогательные файлы (копируются на сервер при установке):
- `bxmcp.service` — systemd-юнит для MCP-сервера
- `bxmcp-embeddings.service` — systemd-юнит для embeddings
- `nginx-camouf.ru.conf` — nginx-конфиг
- `nginx-ratelimit.conf` — rate limiting для nginx
- `cron-bxmcp` — расписание cron

---

## Перенос

### 1. Распаковать код

```bash
mkdir -p /opt/bitrix-mcp
cp -r SWITCH_TO_NEW_SERVER/* /opt/bitrix-mcp/
```

### 2. Установить Node.js (если ещё нет)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
source ~/.bashrc
nvm install 22
```

Создать скрипт-враппер, который systemd использует в `ExecStart`:

```bash
cat > /usr/local/bin/bxmcp-node << 'EOF'
#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
exec node "$@"
EOF
chmod +x /usr/local/bin/bxmcp-node
```

### 3. Установить зависимости Node.js

```bash
cd /opt/bitrix-mcp
npm install
```

### 4. Настроить Python-окружение для embeddings

```bash
cd /opt/bitrix-mcp/python
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn sentence-transformers
```

> В первый раз `sentence-transformers` скачает модель `intfloat/multilingual-e5-small` (~2 GB) в кэш HuggingFace. Это единственная тяжёлая операция, всё остальное — секунды.

### 5. Склонировать документацию

```bash
mkdir -p /opt/bitrix-mcp/data
cd /opt/bitrix-mcp/data
git clone --depth 1 https://github.com/bitrix-tools/framework-docs.git docs
```

### 6. Установить systemd-сервисы

```bash
cp /opt/bitrix-mcp/src/bxmcp.service /etc/systemd/system/
cp /opt/bitrix-mcp/src/bxmcp-embeddings.service /etc/systemd/system/
systemctl daemon-reload
```

### 7. Запустить

```bash
systemctl enable --now bxmcp-embeddings
systemctl enable --now bxmcp
```

### 8. Настроить nginx

```bash
cp /opt/bitrix-mcp/src/nginx-camouf.ru.conf /etc/nginx/sites-available/
ln -s /etc/nginx/sites-available/nginx-camouf.ru.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 9. Настроить cron

```bash
cp /opt/bitrix-mcp/src/cron-bxmcp /etc/cron.d/bxmcp
```

### 10. Переиндексировать PHP-файлы и документацию

```bash
curl -s -X POST http://127.0.0.1:3100/admin/reindex
curl -s -X POST http://127.0.0.1:3100/admin/reindex-docs
```

Первая индексация может занять некоторое время (зависит от сервера).

---

## Проверка

```bash
curl https://bxmcp.camouf.ru/health

curl -X POST https://bxmcp.camouf.ru/ \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

---

## Структура на новом сервере после установки

```
/opt/bitrix-mcp/
├── src/                     # исходники (из архива)
├── dist/                    # скомпилированный JS (из архива)
├── scripts/                 # cron-скрипты (из архива)
├── python/
│   ├── embeddings-service.py  # из архива
│   └── venv/                  # создаётся на шаге 3
├── data/
│   ├── docs/                  # git clone framework-docs
│   ├── index.db               # создаётся при первой индексации
│   └── last_reindex           # служебный файл
├── node_modules/            # npm install
├── package.json
├── package-lock.json
└── tsconfig.json
```

---

## Что НЕ входит в архив (создаётся на новом сервере автоматом)

| Компонент | Как появится |
|---|---|
| `node_modules/` | `npm install` |
| `python/venv/` | `python3 -m venv && pip install` |
| `data/docs/` | `git clone` |
| `data/index.db` | `curl /admin/reindex` |
| systemd-юниты | копируются из `src/` |
| nginx-конфиг | копируется из `src/` |
| cron | копируется из `src/` |
| SSL-сертификаты | `certbot` на новом сервере |
