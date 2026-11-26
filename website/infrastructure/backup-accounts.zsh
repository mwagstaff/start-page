#!/bin/zsh
# Mini's scheduled backup. Sky holds only ciphertext. The recovery key stays off Mini.
set -euo pipefail
umask 077
export PATH="/opt/homebrew/bin:/usr/bin:/bin"
config="$HOME/.config/tab1"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync(process.argv[1]));fs.writeFileSync(process.argv[2],JSON.stringify({uri:c.TAB1_MONGO_URI}),{mode:384})' "$config/accounts.json" "$scratch/dump.yml"
# A standalone mongod has no multi-collection snapshot reads. Retry if this
# database changes while being dumped, without locking other Mini workloads.
cd "$HOME/dev/tab1.net"
db_hash() {
  node --input-type=module - "$scratch/dump.yml" <<'JS'
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
const client = new MongoClient(JSON.parse(readFileSync(process.argv[2])).uri);
try { console.log((await client.db('tab1').command({ dbHash:1 })).md5); }
finally { await client.close(); }
JS
}
consistent=0
for attempt in 1 2 3; do
  before="$(db_hash)"
  mongodump --config "$scratch/dump.yml" --archive="$scratch/tab1.archive.gz" --gzip --quiet
  if [[ "$before" == "$(db_hash)" ]]; then consistent=1; break; fi
done
(( consistent )) || { print -u2 'tab1 changed during all three backup attempts'; exit 1; }
cp "$config/accounts.json" "$scratch/accounts.json"
tar -C "$scratch" -cf - accounts.json tab1.archive.gz | openssl cms -encrypt -binary -aes-256-cbc -outform DER -out "$scratch/backup.cms" "$config/backup-public.pem"
file="$(date -u '+%Y%m%dT%H%M%SZ').cms"
ssh -o BatchMode=yes sky "umask 077; mkdir -p ~/backups/tab1 && cat > ~/backups/tab1/$file.partial && mv ~/backups/tab1/$file.partial ~/backups/tab1/$file && find ~/backups/tab1 -name '*.cms' -type f -mtime +30 -delete" < "$scratch/backup.cms"
print "Stored encrypted tab1 backup $file"
# Expire the private migration copies once the recovery window has passed.
for snapshot in "$HOME"/.local/share/tab1/pre-mongo-*(N/); do
  find "$snapshot/data" -maxdepth 1 -name 'profiles*.json' -type f -mtime +30 -delete
done
