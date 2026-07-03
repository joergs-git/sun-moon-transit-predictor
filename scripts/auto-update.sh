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

# Diagnostic: the version-badge click only works if the stp-update.path
# watcher is installed AND active. auto-update.sh (nightly/manual) does NOT
# install systemd units, so a Pi set up before v0.8.1 and only code-updated
# is missing it. Warn loudly in the journal with the one-time fix so the
# failure mode is discoverable instead of a silent no-op.
if command -v systemctl >/dev/null 2>&1; then
  if ! systemctl is-active --quiet stp-update.path 2>/dev/null; then
    log "WARNING: stp-update.path is not active — the web 'click-to-update'"
    log "         will write a trigger that nothing consumes. One-time fix:"
    log "         re-run  bash scripts/install-pi5.sh  on the Pi."
  fi
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
# Step 4 below runs `npm install`, which rewrites package-lock.json whenever
# the Pi's npm version differs from the one that generated the committed
# lockfile. That local churn then blocks the NEXT `git pull --ff-only` with
# "Your local changes ... would be overwritten by merge". The committed
# lockfile is authoritative, so discard any local edits to it (and to
# package.json, same failure mode) before pulling. Targeted on purpose — we
# do NOT blanket-reset the tree, so a real local change still surfaces.
for f in package-lock.json package.json; do
  if ! git diff --quiet -- "$f" 2>/dev/null; then
    log "discarding local churn in $f before pull (npm-regenerated; committed copy wins)"
    git checkout -- "$f" 2>/dev/null || true
  fi
done

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
# 5. Restart the affected services. The Node predictor (stp.service) and the
#    e-paper client (stp-display.service) are SEPARATE units, so a change under
#    display/ must restart the PANEL — otherwise the running client keeps
#    executing the OLD display/*.py until the next reboot and a pulled fix
#    silently never takes effect there. Frontend files in web/ are served live
#    from disk, so a browser reload is enough for those.
# ---------------------------------------------------------------------------
CHANGED="$(git diff --name-only "$before" "$after")"

# Restart one systemd unit, but only if it is installed AND active on this box
# (a tracker-only Pi has no stp-display; a diskless panel may have no
# stp.service). Uses the narrowly scoped sudoers rule via `sudo -n` so it can
# never hang on a password prompt; a failure — e.g. an older install whose
# sudoers fragment predates stp-display.service — is surfaced with the one-time
# fix instead of aborting the update.
restart_unit() {
  local unit="$1"
  if ! systemctl list-unit-files "$unit" >/dev/null 2>&1; then
    log "$unit not installed — nothing to restart."
    return 0
  fi
  if ! systemctl is-active --quiet "$unit" 2>/dev/null; then
    log "$unit not active — nothing to restart."
    return 0
  fi
  log "restarting $unit ..."
  if [ "$(id -u)" -eq 0 ]; then
    /bin/systemctl restart "$unit" || log "WARNING: could not restart $unit."
  elif command -v sudo >/dev/null 2>&1; then
    if ! sudo -n /bin/systemctl restart "$unit" 2>/dev/null; then
      log "WARNING: could not restart $unit — the sudoers rule may predate it."
      log "         One-time fix: re-run  bash scripts/install-pi5.sh  on the Pi"
      log "         (or restart it by hand: sudo systemctl restart $unit)."
    fi
  else
    /bin/systemctl restart "$unit" || log "WARNING: could not restart $unit."
  fi
}

# Backend code / deps / service unit / example config → restart the predictor.
if echo "$CHANGED" | grep -qE '^(src/|bin/|package(-lock)?\.json|systemd/stp\.service|config/service\.example\.json)'; then
  restart_unit stp.service
else
  log "no backend change — stp.service left running."
fi

# E-paper client code (or its unit) → restart the panel so the new render code
# runs. This is what makes a display-only fix actually reach an installed panel
# through the updater, not just get pulled to disk.
if echo "$CHANGED" | grep -qE '^(display/|systemd/stp-display\.service)'; then
  restart_unit stp-display.service
fi

log "done."
