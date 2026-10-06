#!/bin/sh
# Docker creates bind-mounted ./data as root. Fix ownership once, then drop privileges to `node`.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR/uploads"
  [ "$(stat -c %u "$DATA_DIR")" = "$(id -u node)" ] || chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi
exec "$@"
