#!/bin/bash
DOCS_DIR="/opt/bitrix-mcp/data/docs"

if [ -d "$DOCS_DIR/.git" ]; then
    cd "$DOCS_DIR" && git pull --ff-only
else
    git clone --depth 1 https://github.com/bitrix-tools/framework-docs.git "$DOCS_DIR"
fi

# Trigger reindex of docs
curl -s -X POST http://127.0.0.1:3100/admin/reindex-docs
