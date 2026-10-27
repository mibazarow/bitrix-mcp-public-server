# HOWTO: развёртывание BxMCP с нуля

Пошаговая инструкция, чтобы поднять сервер на чистой машине и получить ровно ту
конфигурацию, которая работает на `bxmcp.camouf.ru`.

## Требования к серверу

| Параметр | Минимум | Проверенная конфигурация |
|---|---|---|
| CPU | 2 vCPU | 2 vCPU (Intel Xeon E312xx, Sandy Bridge) |
| RAM | 6 GB | 7.8 GB, **swap 2–4 GB** |
| Диск | 25 GB | 79 GB (занято ~20 GB) |
| GPU | не нужен | нет |
| ОС | Ubuntu 22.04/24.04 LTS | Debian/Ubuntu, PHP 8.5 |
| Node.js | 22+ | v22.22.3 |
| Python | 3.10+ | 3.12.3 |

Что занимает память в работе:

| Процесс | RSS |
|---|---|
| embeddings (EmbeddingGemma 2, fp32, text-only) | ~2.0 GB |
| bxmcp (Node) | ~0.3 GB |
| MariaDB | ~0.2 GB |
| Apache + nginx + system | ~0.5 GB |

`index.db` — около 500 MB на 53 модуля, `analytics.db` — единицы-десятки MB.

> **Swap обязателен.** Модель грузится в fp32 (~1.1 GB весов), пик при старте —
> около 2 GB. Без swap на 8 GB машине OOM реален.

---

## 1. Подготовка системы

```bash
apt update && apt upgrade -y
apt install -y nginx git curl python3 python3-venv python3-pip build-essential
```

Swap (если его нет):

```bash
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -m   # проверить, что Swap > 0
```

## 2. Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node --version   # v22+
```

## 3. Каталоги

```bash
mkdir -p /opt/bitrix-mcp/{data,python,scripts,dist}
```

Сервисы работают от `root` (нужен доступ к `/home/bitrix/ext_www/.../bitrix/modules`
и к файлам индекса). Отдельный пользователь не обязателен.

## 4. Код

Репозиторий устроен так же, как каталог развёртывания, — копируется целиком:

```
/opt/bitrix-mcp/                  = корень репозитория
├── src/                          # исходники TypeScript
│   ├── index.ts
│   ├── analytics.ts
│   ├── liveapi/{indexer,storage,tools}.ts
│   ├── docs/{service,resources}.ts
│   ├── search/{embeddings,service}.ts
│   ├── utils/{config,php-parser}.ts
│   ├── python/{embeddings-service.py,requirements.txt}
│   ├── scripts/{reindex,update-docs}.sh
│   ├── bxmcp.service
│   ├── bxmcp-embeddings.service
│   ├── nginx-camouf.ru.conf
│   └── cron-bxmcp
├── package.json
├── tsconfig.json                 # rootDir: src, outDir: dist
├── dist/                         # результат сборки (не в git)
└── data/                         # создаётся при работе (не в git)
    ├── index.db                  # SQLite-индекс
    ├── analytics.db              # SQLite-статистика
    └── docs/                     # git clone документации
```

Сборка Node-части (из корня, как на сервере):

```bash
cd /opt/bitrix-mcp
npm install
npm run build      # = tsc, кладёт JS в dist/
```

`tsconfig.json` использует `rootDir: "src"`, поэтому на выходе получается
`dist/index.js`, а не `dist/src/index.js` — именно этот путь прописан в
`ExecStart` юнита `bxmcp.service`.

## 5. Сервис эмбеддингов (EmbeddingGemma 2)

Модель: **`google/embeddinggemma-2`** (Apache 2.0). Грузится в **text-only** режиме:
vision- и audio-энкодеры отключены, поэтому в памяти держится 270M-бэкбон, а не все 740M.

Ключевые ограничения, заложенные в конфиг:

- **Только fp32.** В `float16` модель отдаёт NaN или молча деградирует. `bfloat16`
  безопасен, но на Sandy Bridge без AVX-512 он эмулируется и медленнее fp32.
- **`max_seq_length = 512`.** Окно модели — 8K токенов со sliding window 1024, но
  чанки документации ≤ 1500 символов (~380 токенов). Ограничение защищает от
  патологических входов.
- **`EMBEDDING_THREADS = 2`** на 2 vCPU. Больше потоков даёт только оверхед.

### Мультимодальность (сейчас выключена)

Модель умеет текст, изображения и аудио в одном 768-мерном пространстве, но в этой
конфигурации используются только текст. Включается через `EMBEDDING_TEXT_ONLY=0`
(подробности — в истории git, коммит с поддержкой `/embed/image`).

Если картинки понадобятся, полезно знать заранее:

- **Текстовые векторы от этого не меняются.** Проверено: `max_abs_diff = 0.0` между
  text-only и text+image загрузками, поэтому включать vision можно без переиндексации.
- **Картинки дорогие:** ~88 s на изображение при 280 soft-токенах, ~20–25 s при 70.
  Это в ~34 раза дороже текстового чанка, и vision почти не использует второе ядро.
  Индексировать их надо отдельной ночной очередью.
- **Память:** 440M параметров вместо 270M, RSS ~3.1 GB вместо ~2.0 GB.

### 5.1 Виртуальное окружение

CPU-сборка torch ставится отдельным индексом — иначе pip притянет CUDA-колёса на 5 GB.

```bash
cd /opt/bitrix-mcp/python
python3 -m venv venv-gemma2
./venv-gemma2/bin/pip install -U pip setuptools wheel
./venv-gemma2/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
./venv-gemma2/bin/pip install -r requirements.txt
```

`requirements.txt` фиксирует версии:

```
torch==2.14.1+cpu
torchvision==0.29.1+cpu
sentence-transformers==6.2.0
transformers==5.21.0
huggingface_hub==2.3.0
fastapi==0.162.0
uvicorn==0.54.0
numpy==2.5.4
pydantic==2.14.1
Pillow==13.0.0
```

`torchvision` и `Pillow` нужны обязательно, даже в text-only режиме: загрузчик
`SentenceTransformer` поднимает image processor из конфига модели и падает без них.

### 5.2 Первый запуск и загрузка модели

```bash
cd /opt/bitrix-mcp/python
./venv-gemma2/bin/python -c "
from sentence_transformers import SentenceTransformer
SentenceTransformer('google/embeddinggemma-2')
print('downloaded')
"
```

Веса (~3 GB) лягут в `/root/.cache/huggingface`. Аккаунт HF не нужен — модель не gated.

### 5.3 Проверка профилей

Сервис — общий для нескольких потребителей. Профиль задаёт task-префикс и
размерность; префиксы не косметика, модель обучена с ними.

| Профиль | prompt_name | Фактический префикс |
|---|---|---|
| `docs_query` | `SearchQuery` | `task: search result \| query: ` |
| `docs_passage` | `Document` | `title: none \| text: ` |
| `site_query` | `SearchQuery` | `task: search result \| query: ` |
| `site_passage` | `Document` | `title: none \| text: ` |
| `code_query` | `CodeRetrieval` | `task: code retrieval \| query: ` |
| `generic` | — | без префикса |

```bash
curl -s http://127.0.0.1:8000/profiles | python3 -m json.tool
curl -s -X POST http://127.0.0.1:8000/embed \
  -H 'Content-Type: application/json' \
  -d '{"text":"Как получить элементы инфоблока через ORM","profile":"docs_query"}'
```

Ожидаемая латентность на 2 vCPU Sandy Bridge: **~0.45 s** на короткий запрос,
**~2.6 s** на чанк 1500 символов, **~4.3 s** на 1500 символов с полным окном.

## 6. Документация

```bash
cd /opt/bitrix-mcp/data
git clone --depth 1 https://github.com/bitrix-tools/framework-docs.git docs
```

## 7. systemd

Готовые юниты лежат в `src/` — скопировать как есть.

```bash
cp /opt/bitrix-mcp/src/bxmcp.service /opt/bitrix-mcp/src/bxmcp-embeddings.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bxmcp-embeddings
systemctl enable --now bxmcp
```

`bxmcp-embeddings.service`:

```ini
[Service]
Type=simple
User=root
WorkingDirectory=/opt/bitrix-mcp/python
ExecStart=/opt/bitrix-mcp/python/venv-gemma2/bin/python -m uvicorn embeddings-service:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=5
Environment=EMBEDDING_MODEL=google/embeddinggemma-2
Environment=EMBEDDING_DIM=256
Environment=EMBEDDING_MAX_SEQ=512
Environment=EMBEDDING_THREADS=2
Environment=EMBEDDING_TEXT_ONLY=1
Environment=HF_HOME=/root/.cache/huggingface
Environment=OMP_NUM_THREADS=2
Environment=TOKENIZERS_PARALLELISM=false
```

`bxmcp.service` — переменные, которые должны совпадать с сервисом эмбеддингов:

```ini
Environment=BITRIX_PATH=/home/bitrix/ext_www/camouf.ru/bitrix/modules
Environment=EMBEDDINGS_URL=http://127.0.0.1:8000
Environment=PORT=3100
Environment=EMBEDDING_DIM=256
Environment=EMBEDDING_MODEL=google/embeddinggemma-2
```

`EMBEDDING_DIM` и `EMBEDDING_MODEL` — не декорация: из них собирается подпись
индекса (`google/embeddinggemma-2@256`). Если подпись в БД не совпадает с текущей,
следующая индексация полностью пересоберёт `doc_chunks`. При несовпадении размерности
векторов поиск отбрасывает несовместимые записи, а не считает мусор.

`/usr/local/bin/bxmcp-node` — обёртка для nvm:

```bash
#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
exec node "$@"
```

## 8. nginx

Готовый конфиг — `src/nginx-camouf.ru.conf`, копируется в
`/etc/nginx/sites-available/camouf.ru.conf` и включается симлинком в `sites-enabled`.

- `bxmcp.camouf.ru` → `127.0.0.1:3100` (MCP в корне), `/embed/` → `127.0.0.1:8000`
- `camouf.ru` → apache (`127.0.0.1:8090`), плюс `/mcp-usage` и `/mcp-stats` → `127.0.0.1:3100/admin/*`
- `limit_req` не используется

```bash
nginx -t && systemctl reload nginx
```

SSL:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d camouf.ru -d bxmcp.camouf.ru
```

## 9. Индексация PHP-файлов Bitrix

```bash
ls /home/bitrix/ext_www/camouf.ru/bitrix/modules/

curl -X POST http://127.0.0.1:3100/admin/reindex
curl http://127.0.0.1:3100/admin/progress
# {"isIndexing":false,"progress":"done: {\"modulesIndexed\":53,...}"}

curl -X POST http://127.0.0.1:3100/admin/reindex-components
curl http://127.0.0.1:3100/admin/progress
```

## 10. Индексация документации (эмбеддинги)

```bash
curl -X POST http://127.0.0.1:3100/admin/reindex-docs
curl http://127.0.0.1:3100/admin/progress
```

Прогресс выглядит так:

```json
{"isIndexing": true, "progress": "docs 1240/5581 (embedded 1240)"}
```

**Сколько это занимает.** ~5581 чанк × ~1.8 s ≈ **2.5–3 часа** на 2 vCPU. Это
разовая операция; дальше индексация инкрементальная (см. §11). Во время
переиндексации `searchDocs` отвечает по тем чанкам, что уже готовы.

Проверка результата:

```bash
curl -s -X POST http://127.0.0.1:3100/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"searchDocs","arguments":{"query":"получить элементы инфоблока через ORM"}}}' \
  | jq -r '.result.content[0].text' | head -40
```

## 11. Cron

Готовое расписание — `src/cron-bxmcp` → `/etc/cron.d/bxmcp`:

```bash
0 1 * * * root /opt/bitrix-mcp/scripts/reindex.sh >> /var/log/bxmcp-reindex.log 2>&1
0 4 * * * root /opt/bitrix-mcp/scripts/update-docs.sh >> /var/log/bxmcp-docs.log 2>&1
```

- `reindex.sh` — если в `/home/bitrix/ext_www/camouf.ru/bitrix/modules` появились
  новые `.php`, дергает `POST /admin/reindex`.
- `update-docs.sh` — `git pull` (или `git clone` при первом запуске) документации,
  затем `POST /admin/reindex-docs`.

### Модули: проверка дешёвая, переиндексация полная

`reindex.sh` сравнивает mtime файлов с маркером `data/last_reindex`. Если Bitrix не
обновлялся, изменённых `.php` нет, `POST /admin/reindex` **не отправляется вообще** —
ночной прогон занимает секунды.

Когда изменения есть, переиндексация **полная**: `clearModuleData()` по каждому модулю
и повторный парсинг всех файлов. Инкрементального режима для модулей нет и он не нужен:
на 53 модуля и 918 компонентов (113k функций, 20k классов) полный проход занимает
**~11 минут** (замер: `2026-10-20 22:00:04 → 22:10:56`). При еженедельном обновлении
ядра это одна ночь в неделю.

Пока идёт переиндексация, индекс виден в промежуточном состоянии: модуль сначала
удаляется, потом наполняется заново. Запрос в этот момент может не найти часть
модулей. Окно — те же ~11 минут ночью.

**Ограничение детектора.** Проверка реагирует только на новые и изменённые файлы.
Если обновление *удалит* модуль, не тронув соседние файлы, маркер не сработает и
запись останется в индексе. На практике updater всегда трогает соседние файлы, но
если появился «фантомный» модуль — лечится ручным `POST /admin/reindex`.

### Документация: инкрементальная

`reindex-docs` не пересчитывает всё подряд: чанк с неизменным содержимым пропускается,
удалённые чанки вычищаются. Ежедневный `git pull` документации поэтому занимает
секунды-минуты, а не 3 часа. Полный пересчёт происходит только при смене модели или
размерности (подпись индекса в `meta.embeddings_signature`).

## 12. Проверка работоспособности

```bash
curl -s http://127.0.0.1:8000/health | python3 -m json.tool   # модель, профили, счётчики
curl -s http://127.0.0.1:3100/health | python3 -m json.tool   # версия + подпись индекса
curl -s https://bxmcp.camouf.ru/health
```

`/health` у bxmcp отдаёт блок `embeddings` — модель, размерность и подпись. Если
`signature` не совпадает с тем, что в БД, нужна переиндексация.

```bash
# tools/list
curl -s -X POST https://bxmcp.camouf.ru/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## 13. fail2ban (опционально)

```bash
apt install -y fail2ban
```

```ini
# /etc/fail2ban/jail.local
[bxmcp]
enabled = true
port = http,https
filter = bxmcp
logpath = /var/log/nginx/access.log
maxretry = 10
findtime = 60
bantime = 3600
```

```ini
# /etc/filter.d/bxmcp.conf
[Definition]
failregex = ^<HOST> .* "(GET|POST) /mcp/.*" 40[0-9]
ignoreregex =
```

## 14. Подключение клиентов

```json
{
  "mcpServers": {
    "bitrix": {
      "url": "https://bxmcp.camouf.ru/mcp"
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
      "args": ["-y", "mcp-remote", "https://bxmcp.camouf.ru"]
    }
  }
}
```

---

## Обслуживание

### Сменить модель или размерность эмбеддингов

1. Изменить `EMBEDDING_MODEL` / `EMBEDDING_DIM` в обоих юнитах.
2. `systemctl daemon-reload && systemctl restart bxmcp-embeddings bxmcp`.
3. `curl -X POST http://127.0.0.1:3100/admin/reindex-docs` — полный пересчёт
   запустится автоматически, потому что подпись индекса изменилась.

`doc_chunks` при этом очищается целиком: смешивать векторы разных моделей или
размерностей в одном косинусе нельзя.

### Добавить нового потребителя (второй сайт, другой индекс)

Ничего в модели не меняется — добавляется профиль в `PROFILES` внутри
`python/embeddings-service.py` и потребитель ходит на тот же `127.0.0.1:8000`
со своим `profile` и, при необходимости, своим `dim`.

Размерности у потребителей независимы (MRL: 128/256/512/768) — хранилища всё
равно раздельные.

### Приоритеты запросов

Интерактивные запросы (`searchDocs`, чат) и массовая индексация делят один процесс.
Индексация идёт по одному чанку за HTTP-вызов, поэтому интерактивный запрос встаёт
в очередь максимум на один чанк (~2–4 s). При нескольких потребителях с тяжёлой
индексацией имеет смысл поднять второй экземпляр сервиса на другом порту.

---

## Структура репозитория

```
bxmcp/
├── PUBLIC_BITRIX_MCP.md          # архитектура проекта
├── README.md                     # быстрый старт для пользователей
├── HOWTO.md                      # этот файл — развёртывание с нуля
├── BITRIX24_MCP.md               # ТЗ на MCP-сервер для Битрикс24
├── package.json
├── package-lock.json
├── tsconfig.json                 # rootDir: src, outDir: dist
└── src/
    ├── index.ts                  # точка входа сервера
    ├── analytics.ts              # статистика использования
    ├── bxmcp.service             # systemd unit (MCP)
    ├── bxmcp-embeddings.service  # systemd unit (embeddings)
    ├── nginx-camouf.ru.conf      # nginx конфиг
    ├── cron-bxmcp                # расписание cron
    ├── liveapi/
    │   ├── indexer.ts            # индексация PHP-файлов
    │   ├── storage.ts            # SQLite storage
    │   └── tools.ts              # MCP инструменты LiveAPI
    ├── docs/
    │   ├── service.ts            # работа с markdown
    │   └── resources.ts          # MCP resources bx-docs://
    ├── search/
    │   ├── embeddings.ts         # клиент Python-сервиса (профили)
    │   └── service.ts            # семантический поиск, инкрементальная индексация
    ├── utils/
    │   ├── config.ts             # конфигурация (пути, порты, модель)
    │   └── php-parser.ts         # regex-парсер PHP
    ├── python/
    │   ├── embeddings-service.py # FastAPI: профили, MRL, батчи
    │   └── requirements.txt
    └── scripts/
        ├── reindex.sh            # автоиндексация (cron: 01:00)
        └── update-docs.sh        # обновление docs (cron: 04:00)
```
