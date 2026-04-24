#!/bin/bash
BITRIX_PATH="/home/bitrix/ext_www/camouf.ru/bitrix/modules"
LAST_RUN="/opt/bitrix-mcp/data/last_reindex"

if [ ! -f "$LAST_RUN" ]; then
    touch "$LAST_RUN"
fi

CHANGES=$(find "$BITRIX_PATH" -name "*.php" -newer "$LAST_RUN" 2>/dev/null | wc -l)

if [ "$CHANGES" -gt 0 ]; then
    curl -s -X POST http://127.0.0.1:3100/admin/reindex
fi
touch "$LAST_RUN"
