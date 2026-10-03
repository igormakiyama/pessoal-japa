#!/usr/bin/env bash
# Backup do banco e das histórias. Guarda os últimos 7 dias em ./backups.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M)
# Cópia consistente do SQLite mesmo com o sistema rodando
docker compose exec -T web python -c "
import sqlite3
src = sqlite3.connect('/app/data/historinhas.db')
dst = sqlite3.connect('/app/data/backup.db')
src.backup(dst)
dst.close()
"
tar czf "backups/historinhas-${STAMP}.tar.gz" --exclude='data/voices' --exclude='data/historinhas.db*' data
rm -f data/backup.db
ls -1t backups/historinhas-*.tar.gz | tail -n +8 | xargs -r rm -f
echo "Backup salvo em backups/historinhas-${STAMP}.tar.gz"
