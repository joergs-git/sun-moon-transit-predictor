#!/usr/bin/env bash
# Pulls origin/main, refreshes deps, restarts stp.service IFF HEAD moved.
#
# Used by:
#   - systemd/stp-update.service  (called on the schedule in stp-update.timer)
#   - manual:  bash scripts/auto-update.sh
#
# Safe to run while the service is live. Local config files
# (config/observer.json, config/service.json) are explicitly backed up before
# the pull and restored afterwards, so an upstream rename or .gitignore change
# can never wipe a per-site setup.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

log() { printf '[stp-update] %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 0. Consume the web-UI trigger, if this run was kicked off by the
#    stp-update.path unit. Removing it clears that unit's PathExists=
#    condition so a single click can't make the updater loop. Harmless on a
#    timer/manual run where the file does not exist.
# ---------------------------------------------------------------------------
if [ -f "$REPO_DIR/data/update.request" ]; then
  log "web-UI update trigger found; consuming it."
  rm -f "$REPO_DIR/data/update.request" || true
fi

# ---------------------------------------------------------------------------
# 1. Back up local config so the pull cannot delete or overwrite it.
# ---------------------------------------------------------------------------
BACKUP_DIR="$(mktemp -d -t stp-update.XXXXXX)"
trap 'rm -rf "$BACKUP_DIR"' EXIT
for f in config/observer.json config/service.json; do
  if [ -f "$f" ]; then
    cp -p "$f" "$BACKUP_DIR/$(basename "$f")"
  fi
done

# ---------------------------------------------------------------------------
# 2. Fast-forward only. Never auto-resolve merges in the background.
# ---------------------------------------------------------------------------
before="$(git rev-parse HEAD)"
if ! git pull --ff-only --quiet; then
  log "git pull failed (non-fast-forward or network); leaving service running."
  exit 0
fi
after="$(git rev-parse HEAD)"

# ---------------------------------------------------------------------------
# 3. Restore any local config that the pull dropped (idempotent if untouched).
# ---------------------------------------------------------------------------
for f in observer.json service.json; do
  if [ -f "$BACKUP_DIR/$f" ] && [ ! -f "config/$f" ]; then
    log "restoring config/$f after pull (was untracked locally)"
    cp -p "$BACKUP_DIR/$f" "config/$f"
  fi
done

if [ "$before" = "$after" ]; then
  log "no new commits; nothing to do."
  exit 0
fi

log "updating: $before → $after"

# ---------------------------------------------------------------------------
# 4. Refresh production deps only if the lockfile or manifest moved.
# ---------------------------------------------------------------------------
if git diff --name-only "$before" "$after" | grep -qE '^(package\.json|package-lock\.json)$'; then
  log "package.json changed; running npm install --omit=dev"
  npm install --omit=dev --silent
fi

# ---------------------------------------------------------------------------
# 5. Restart only if backend code, deps or service config changed. Frontend
#    files in web/ are served live from disk — a browser reload picks them up.
# ---------------------------------------------------------------------------
CHANGED="$(git diff --name-only "$before" "$after")"
if echo "$CHANGED" | grep -qE '^(src/|bin/|package(-lock)?\.json|systemd/stp\.service|config/service\.example\.json)'; then
  log "restarting stp.service ..."
  if command -v sudo >/dev/null 2>&1; then
    sudo /bin/systemctl restart stp.service
  else
    /bin/systemctl restart stp.service
  fi
else
  log "frontend / docs only — no restart required."
fi

log "done."
