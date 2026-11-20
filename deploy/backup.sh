#!/usr/bin/env bash
# Daily database backup, run by cron as daitcrm (see docs/DEPLOYMENT.md):
#   30 2 * * * /home/daitcrm/live/current/deploy/backup.sh >> /home/daitcrm/backups/backup.log 2>&1
# Usage: backup.sh [db ...]      (default: dait_crm dait_crm_test)
# Connection: PGPASSWORD in the environment, or a ~/.pgpass file (mode 600) with one line per database:
#   localhost:5432:<db>:<user>:<password>
# Env: BACKUP_DIR (default ~/backups), BACKUP_HOST (default localhost), BACKUP_KEEP_DAYS (default 14).
set -euo pipefail
if [[ -s $HOME/.nvm/nvm.sh ]]; then . "$HOME/.nvm/nvm.sh" > /dev/null; fi
DIR=${BACKUP_DIR:-$HOME/backups}; HOST=${BACKUP_HOST:-localhost}; DAYS=${BACKUP_KEEP_DAYS:-14}
DBS=("$@"); [[ ${#DBS[@]} -gt 0 ]] || DBS=(dait_crm dait_crm_test)
mkdir -p "$DIR"; stamp=$(date +%Y%m%d-%H%M)
for db in "${DBS[@]}"; do
  out="$DIR/$db-$stamp.dump"
  # The login user is named after the database's owner; override with PGUSER when it differs.
  pg_dump -Fc -h "$HOST" -U "${PGUSER:-$db}" -d "$db" -f "$out.tmp"
  mv "$out.tmp" "$out"
  echo "Backed up $db to $out"
done
find "$DIR" -maxdepth 1 -name '*.dump' -mtime +"$DAYS" -delete
if command -v rclone > /dev/null && rclone listremotes | grep -qx 'onedrive-crm:'; then
  rclone copy "$DIR" onedrive-crm:DAIT-CRM-backups
  echo "Copied backups to onedrive-crm:DAIT-CRM-backups"
else
  echo "rclone remote onedrive-crm: not configured; backups stay on this server only" >&2
fi
