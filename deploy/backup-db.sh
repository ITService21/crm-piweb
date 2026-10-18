#!/usr/bin/env bash
# Nightly logical backup. Cron: 15 2 * * * /var/www/piweb-crm/deploy/backup-db.sh
# Credentials come from ~/.my.cnf-style file (chmod 600) so they never appear in the process list.
set -euo pipefail
BACKUP_DIR="${BACKUP_DIR:-/var/backups/piweb-crm}"
DB_NAME="${DB_NAME:?set DB_NAME}"
DEFAULTS_FILE="${DEFAULTS_FILE:-/etc/piweb-crm/backup.cnf}"   # [client] user=... password=...
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
OUT="$BACKUP_DIR/${DB_NAME}_$(date +%F_%H%M).sql.gz"
mysqldump --defaults-extra-file="$DEFAULTS_FILE" --single-transaction --no-tablespaces --quick "$DB_NAME" | gzip > "$OUT"
find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -mtime +14 -delete
echo "backup written: $OUT"
