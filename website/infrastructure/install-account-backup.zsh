#!/bin/zsh
# Run on Mini as the tab1 service user, after installing its public recovery certificate.
set -euo pipefail
umask 077
folder="$HOME/.local/share/tab1"
mkdir -p "$folder" "$HOME/Library/LaunchAgents"
install -m 700 "${0:A:h}/backup-accounts.zsh" "$folder/backup-accounts.zsh"
export TAB1_BACKUP_ROOT="$folder"
name=com.tab1.net.account-backup
plist="$HOME/Library/LaunchAgents/$name.plist"
/usr/bin/python3 - "$plist" <<'PY'
import os, plistlib, sys
from pathlib import Path
root = Path(os.environ["TAB1_BACKUP_ROOT"])
Path(sys.argv[1]).write_bytes(plistlib.dumps({
    "Label": "com.tab1.net.account-backup",
    "ProgramArguments": ["/bin/zsh", str(root / "backup-accounts.zsh")],
    "StartCalendarInterval": {"Hour": 2, "Minute": 45},
    "StandardOutPath": str(root / "backup.log"),
    "StandardErrorPath": str(root / "backup.error.log"),
}))
PY
domain="gui/$(id -u)"
if launchctl print "$domain/$name" >/dev/null 2>&1; then launchctl bootout "$domain/$name"; fi
launchctl bootstrap "$domain" "$plist"
launchctl print "$domain/$name" | head -15
