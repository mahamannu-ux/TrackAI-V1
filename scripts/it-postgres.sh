#!/usr/bin/env bash
# agent-kit: run a command against a throwaway Postgres on a free port, then remove it.
#
#   scripts/it-postgres.sh <command> [args...]
#   scripts/it-postgres.sh npm run test:integration
#   scripts/it-postgres.sh python -m pytest tests/integration/db -q
#
# Why: a long-running local Postgres (or another project's) often answers on 5432, and
# fixed ports kept failing agent sandboxes. Every integration run gets its own server.
#
# Mode: Docker when a daemon answers (publishes 127.0.0.1::5432, a random host port);
# otherwise initdb + pg_ctl from /usr/lib/postgresql/$IT_PG_VERSION/bin or PATH.
# The script exits with the command's status. An EXIT trap removes the container, or
# stops the cluster and deletes its temp dir, on success, failure and Ctrl-C.
#
# Variables (all optional):
#   IT_PG_MODE        docker | local | auto (default auto)
#   IT_PG_VERSION     major version for the local binaries and the image tag (default 16)
#   IT_PG_IMAGE       Docker image (default postgres:$IT_PG_VERSION)
#   IT_PG_USER        superuser of the throwaway server (default app)
#   IT_PG_PASSWORD    its password (default dev; the server lives only for this run)
#   IT_PG_DATABASES   space-separated databases to create (default "app_it")
#   IT_PG_URL_SCHEME  URL scheme for exported URLs (default postgresql; e.g. postgresql+psycopg)
#   IT_PG_EXPORTS     space-separated VAR=database pairs to export as URLs
#                     (default "INTEGRATION_DATABASE_URL=<first database>")
# The command also sees PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE (first database).
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/it-postgres.sh <command> [args...]" >&2
  exit 2
fi

MODE="${IT_PG_MODE:-auto}"
PG_VERSION="${IT_PG_VERSION:-16}"
IMAGE="${IT_PG_IMAGE:-postgres:$PG_VERSION}"
PG_USER="${IT_PG_USER:-app}"
PG_PASSWORD="${IT_PG_PASSWORD:-dev}"
read -r -a DATABASES <<<"${IT_PG_DATABASES:-app_it}"
SCHEME="${IT_PG_URL_SCHEME:-postgresql}"

if [ "${#DATABASES[@]}" -eq 0 ]; then
  echo "it-postgres: IT_PG_DATABASES is empty" >&2
  exit 2
fi
EXPORTS="${IT_PG_EXPORTS:-INTEGRATION_DATABASE_URL=${DATABASES[0]}}"
for db in "${DATABASES[@]}"; do
  [[ "$db" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || { echo "it-postgres: bad database name '$db'" >&2; exit 2; }
done
for pair in $EXPORTS; do
  [[ "$pair" =~ ^[A-Za-z_][A-Za-z0-9_]*=[a-zA-Z_][a-zA-Z0-9_]*$ ]] || {
    echo "it-postgres: IT_PG_EXPORTS entries must be VAR=database, got '$pair'" >&2
    exit 2
  }
  case " ${DATABASES[*]} " in
    *" ${pair#*=} "*) ;;
    *) echo "it-postgres: IT_PG_EXPORTS names '${pair#*=}', which is not in IT_PG_DATABASES" >&2; exit 2 ;;
  esac
done

container=""
workdir=""
bindir=""
port=""
as_owner=()

# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ -n "$container" ]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  if [ -n "$workdir" ]; then
    if [ -f "$workdir/data/postmaster.pid" ]; then
      ${as_owner[@]+"${as_owner[@]}"} "$bindir/pg_ctl" -D "$workdir/data" -m immediate -w stop >/dev/null 2>&1 || true
    fi
    rm -rf "$workdir"
  fi
  exit "$status"
}

# The command runs in the background so a TERM sent to this script alone (CI, a parent
# process) is handled at once, not after a long run. A background child ignores SIGINT
# in a non-interactive shell, so Ctrl-C is forwarded as TERM.
# shellcheck disable=SC2329  # invoked by the INT/TERM traps
stop_child() {
  # `jobs -p`, not a saved pid: a signal can land after the fork but before child=$!.
  local pids
  pids="$(jobs -p)"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086  # word splitting of the pid list is intended
    kill -TERM $pids 2>/dev/null || true
    # shellcheck disable=SC2086
    wait $pids 2>/dev/null || true
  fi
  exit "$1"
}
trap cleanup EXIT
trap 'stop_child 130' INT
trap 'stop_child 143' TERM

free_port() {
  # Bind port 0 and let the kernel pick; the socket closes before Postgres binds.
  if command -v "${PYTHON3:-python3}" >/dev/null 2>&1; then
    "${PYTHON3:-python3}" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'
  elif command -v node >/dev/null 2>&1; then
    node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
  else
    echo "it-postgres: local mode needs python3 or node to pick a free port" >&2
    return 1
  fi
}

docker_ready() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

find_bindir() {
  if [ -x "/usr/lib/postgresql/$PG_VERSION/bin/initdb" ]; then
    echo "/usr/lib/postgresql/$PG_VERSION/bin"
  elif command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v initdb)"
  else
    return 1
  fi
}

start_docker() {
  container="$(docker run -d --rm \
    -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB="${DATABASES[0]}" \
    -p 127.0.0.1::5432 "$IMAGE")"
  port="$(docker port "$container" 5432/tcp | head -n 1 | sed 's/.*://')"
  # Over TCP, so the image's init-time server (socket only) does not count as ready.
  for _ in $(seq 1 120); do
    if docker exec "$container" pg_isready -q -h 127.0.0.1 -U "$PG_USER" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  docker exec "$container" pg_isready -q -h 127.0.0.1 -U "$PG_USER" || {
    echo "it-postgres: the Postgres container did not become ready" >&2
    docker logs "$container" >&2 || true
    exit 3
  }
  for db in "${DATABASES[@]:1}"; do
    docker exec "$container" psql -q -h 127.0.0.1 -U "$PG_USER" -d "${DATABASES[0]}" -c "CREATE DATABASE $db" >/dev/null
  done
}

start_local() {
  bindir="$(find_bindir)" || {
    echo "it-postgres: no Docker daemon and no Postgres binaries (initdb, pg_ctl) found" >&2
    exit 3
  }
  workdir="$(mktemp -d "${TMPDIR:-/tmp}/it-pg.XXXXXX")"
  # initdb refuses to run as root (agent sandboxes): run the server as postgres.
  if [ "$(id -u)" -eq 0 ]; then
    chown postgres "$workdir"
    as_owner=(runuser -u postgres --)
  fi
  printf '%s\n' "$PG_PASSWORD" >"$workdir/pw"
  if [ "$(id -u)" -eq 0 ]; then chown postgres "$workdir/pw"; fi
  ${as_owner[@]+"${as_owner[@]}"} env LC_ALL=C "$bindir/initdb" -D "$workdir/data" -U "$PG_USER" --pwfile="$workdir/pw" \
    --auth-local=trust --auth-host=scram-sha-256 -E UTF8 --no-locale >"$workdir/initdb.log" 2>&1 || {
    cat "$workdir/initdb.log" >&2
    exit 3
  }
  port="$(free_port)" || exit 3
  # TCP only: a Unix socket under a long TMPDIR (macOS /var/folders/…) exceeds the
  # 103-byte socket path limit and the server refuses to start.
  # LC_ALL=C: on macOS a postmaster without a valid LC_ALL can become multithreaded
  # during startup (locale lookup) and refuse to start.
  ${as_owner[@]+"${as_owner[@]}"} env LC_ALL=C "$bindir/pg_ctl" -D "$workdir/data" -l "$workdir/server.log" -w -t 60 \
    -o "-p $port -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c fsync=off -c timezone=UTC" \
    start >/dev/null || {
    cat "$workdir/server.log" >&2
    exit 3
  }
  for _ in $(seq 1 60); do
    if "$bindir/pg_isready" -q -h 127.0.0.1 -p "$port"; then
      break
    fi
    sleep 0.5
  done
  "$bindir/pg_isready" -q -h 127.0.0.1 -p "$port" || {
    echo "it-postgres: the local Postgres did not become ready" >&2
    cat "$workdir/server.log" >&2
    exit 3
  }
  for db in "${DATABASES[@]}"; do
    PGPASSWORD="$PG_PASSWORD" "$bindir/createdb" -h 127.0.0.1 -p "$port" -U "$PG_USER" "$db"
  done
}

case "$MODE" in
  docker) start_docker ;;
  local) start_local ;;
  auto) if docker_ready; then start_docker; else start_local; fi ;;
  *)
    echo "it-postgres: IT_PG_MODE must be docker, local or auto" >&2
    exit 2
    ;;
esac

base="$SCHEME://$PG_USER:$PG_PASSWORD@127.0.0.1:$port"
for pair in $EXPORTS; do
  export "${pair%%=*}=$base/${pair#*=}"
done
export PGHOST=127.0.0.1 PGPORT="$port" PGUSER="$PG_USER" PGPASSWORD="$PG_PASSWORD" PGDATABASE="${DATABASES[0]}"
echo "throwaway Postgres on 127.0.0.1:$port"

set +e
# Explicit stdin: a background command would otherwise read from /dev/null.
"$@" <&0 &
wait "$!"
status=$?
set -e
exit "$status"
