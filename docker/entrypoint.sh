#!/bin/sh
set -eu
mkdir -p /data /photos
chown node:node /data
chmod 755 /photos || true
exec su-exec node node scripts/start-prod.mjs
