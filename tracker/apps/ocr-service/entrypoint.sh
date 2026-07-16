#!/bin/sh
# Runs as root (the image's default user) before the app drops to the
# unprivileged `ocr` user. Bind-mounted volumes (e.g. docker-compose's
# ./data/ocr:/data) are created by Docker on first run as root:root, which
# `ocr` can't write into -- that made aiosqlite.connect(JOBS_DB_PATH) fail
# with "unable to open database file". Fixing ownership here means it works
# regardless of how the host-side directory got created.
set -eu

db_dir=$(dirname "${JOBS_DB_PATH:-/data/jobs.db}")
mkdir -p "$db_dir"
chown -R ocr:ocr "$db_dir"

exec setpriv --reuid=ocr --regid=ocr --init-groups "$@"
