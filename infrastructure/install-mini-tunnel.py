#!/usr/bin/env python3
"""Install the dedicated tab1 connector; no secrets are embedded in the plist.

Run on Mini as mwagstaff with --user, or with sudo for a boot LaunchDaemon.
The tunnel token must already exist at the private path below.
"""
import os
import pathlib
import plistlib
import subprocess
import sys

USER = 'mwagstaff'
HOME = pathlib.Path('/Users') / USER
LABEL = 'com.tab1.net.tunnel'
TOKEN = HOME / '.cloudflared/tab1-mini/token'
user_mode = sys.argv[1:] == ['--user']
if sys.argv[1:] not in ([], ['--user']):
    sys.exit('Usage: install-mini-tunnel.py [--user]')
if sys.platform != 'darwin':
    sys.exit('This installer is for the Mini macOS host only.')
if not user_mode and os.geteuid() != 0:
    sys.exit('Run with sudo to install the boot service, or --user for a login service.')
if user_mode and pathlib.Path('/Library/LaunchDaemons', LABEL + '.plist').exists():
    sys.exit('The boot service is already installed; do not create a second login connector.')
if not TOKEN.is_file() or TOKEN.stat().st_mode & 0o077:
    sys.exit('Missing token or unsafe permissions; token must have mode 600.')
uid = int(subprocess.check_output(['id', '-u', USER]).strip())
if TOKEN.stat().st_uid != uid:
    sys.exit('Token must be owned by mwagstaff so the unprivileged connector can read it.')
if not os.access('/opt/homebrew/bin/cloudflared', os.X_OK):
    sys.exit('Install cloudflared with Homebrew first.')
logs = HOME / 'Library/Logs/tab1-mini-tunnel'
logs.mkdir(mode=0o700, parents=True, exist_ok=True)
if not user_mode:
    os.chown(logs, uid, -1)
target = (HOME / 'Library/LaunchAgents' if user_mode else pathlib.Path('/Library/LaunchDaemons')) / (LABEL + '.plist')
domain = f'gui/{uid}' if user_mode else 'system'
config = {
    'Label': LABEL,
    'ProgramArguments': ['/opt/homebrew/bin/cloudflared', '--no-autoupdate',
                         'tunnel', '--metrics', '127.0.0.1:20246',
                         'run', '--token-file', str(TOKEN)],
    'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 5,
    'StandardOutPath': str(logs / 'stdout.log'),
    'StandardErrorPath': str(logs / 'stderr.log'),
}
if not user_mode:
    config['UserName'] = USER
    config['GroupName'] = 'staff'
    # Replace only this connector's temporary login service.
    old = HOME / 'Library/LaunchAgents' / (LABEL + '.plist')
    if old.exists():
        subprocess.run(['launchctl', 'bootout', f'gui/{uid}', str(old)], check=False)
        old.unlink()
subprocess.run(['launchctl', 'bootout', domain, str(target)], check=False, capture_output=True)
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(plistlib.dumps(config))
target.chmod(0o644)
subprocess.run(['plutil', '-lint', str(target)], check=True)
subprocess.run(['launchctl', 'bootstrap', domain, str(target)], check=True)
subprocess.run(['launchctl', 'print', domain + '/' + LABEL], check=True)
