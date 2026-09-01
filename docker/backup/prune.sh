#!/bin/sh
# Retention enforcement. Called by backup.sh ONLY after a successful snapshot,
# or by an operator who has just inspected `restic snapshots` by hand.
#
# 14 daily / 8 weekly / 12 monthly. The repo is a local encrypted filesystem
# backend on this host; `--prune` reclaims space in it.
set -eu

read_file_env() {
  eval "_v=\${$1:-}"; eval "_f=\${${1}_FILE:-}"
  if [ -z "$_v" ] && [ -n "$_f" ] && [ -r "$_f" ]; then
    _v=$(cat "$_f"); export "$1=$_v"
  fi
}
read_file_env RESTIC_PASSWORD

# Guard: never run forget/prune against an empty or unreachable repository.
if [ "$(restic snapshots --json | jq 'length')" -lt 1 ]; then
  echo "no snapshots visible; refusing to run forget/prune" >&2
  exit 1
fi

exec restic forget --host reino --tag reino-daily \
  --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
