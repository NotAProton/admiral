#!/bin/sh
# Run on the Docker host; never copy the live WAL database file directly.
set -eu

backup_dir="${ADMIRAL_BACKUP_DIR:-$HOME/admiral-backups}"
container="${ADMIRAL_WORKER_CONTAINER:-admiral-deploy-worker-1}"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

docker exec "$container" node -e '
  import("node:sqlite").then(async ({DatabaseSync, backup}) => {
    const db = new DatabaseSync("/app/data/admiral.db", {readOnly: true});
    try { await backup(db, "/app/data/admiral-backup.tmp.db"); }
    finally { db.close(); }
  }).catch((error) => { console.error(error); process.exit(1); });
'
docker cp "$container:/app/data/admiral-backup.tmp.db" "$backup_dir/admiral-$stamp.db"
docker exec "$container" node -e 'import("node:fs").then(fs => fs.unlinkSync("/app/data/admiral-backup.tmp.db"))'
chmod 600 "$backup_dir/admiral-$stamp.db"
find "$backup_dir" -maxdepth 1 -type f -name 'admiral-*.db' -mtime +7 -delete
