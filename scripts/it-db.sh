#!/usr/bin/env bash
# TrackAI: run a command against a throwaway PostgreSQL 16 + pgvector on a free port.
#
#   scripts/it-db.sh <command> [args...]
#   scripts/it-db.sh npm run verify:task5-graph-live -w apps/api
#   scripts/it-db.sh sh -c 'npm run verify:task5-schema -w apps/api && npm run verify:task6-route-live -w apps/api'
#
# Wraps agent-kit's scripts/it-postgres.sh (Docker when a daemon answers, otherwise local
# initdb/pg_ctl binaries that have the pgvector extension). It exports DATABASE_URL for the
# throwaway database only, marks it ephemeral for the Task5/Task6 live verifiers, supplies a
# throwaway encryption key ring, applies the Drizzle migrations, then runs the command.
# The database is removed on exit, whatever the outcome. Never point these flags at a
# database you care about (AGENTS.md §9).
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/it-db.sh <command> [args...]" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

export IT_PG_IMAGE="${IT_PG_IMAGE:-pgvector/pgvector:pg16}"
export IT_PG_VERSION="${IT_PG_VERSION:-16}"
export IT_PG_DATABASES="${IT_PG_DATABASES:-trackai}"
export IT_PG_EXPORTS="${IT_PG_EXPORTS:-DATABASE_URL=trackai}"
export TASK5_EPHEMERAL_DATABASE=1
export TASK6_EPHEMERAL_DATABASE=1
# Test-only key ring (32 bytes of ASCII digits/letters, base64): never used outside this run.
export MASTER_ENCRYPTION_KEY_ACTIVE_VERSION="${MASTER_ENCRYPTION_KEY_ACTIVE_VERSION:-it-v1}"
export MASTER_ENCRYPTION_KEYS_JSON="${MASTER_ENCRYPTION_KEYS_JSON:-{\"it-v1\":\"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=\"}}"

cd "$REPO"
# "$0" of the inner shell is "it-db"; "$@" is the caller's command, passed through untouched.
exec "$HERE/it-postgres.sh" sh -c 'npm run -s db:migrate -w apps/api >/dev/null && echo "it-db: migrations applied" && exec "$@"' it-db "$@"
