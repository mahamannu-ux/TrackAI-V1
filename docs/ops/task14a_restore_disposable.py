#!/usr/bin/env python3
"""Restore Task14a's encrypted CLI export to its named disposable project only.

Run this interactively in Terminal. No database password or plaintext SQL is
written to disk or passed on a command line. The source project is never used.
"""

import argparse
import getpass
import os
import subprocess
import sys
import termios
import time
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


DESTINATION_REF = "glwwxaobocwoczvjmrod"
DESTINATION_HOST = "aws-0-ap-northeast-1.pooler.supabase.com"
BACKUP_DIR = Path("/Users/manishmahajan/AIProjects/_task14a_backup_20261024")
MAGIC = b"T14A1"
RESERVED_ROLE_SETTING = b'ALTER ROLE "supabase_admin" SET "statement_timeout" TO \'0\';'


def decrypt_export(name: str, key: bytes) -> bytes:
    blob = (BACKUP_DIR / f"{name}.sql.gcm").read_bytes()
    if blob[:5] != MAGIC:
        raise ValueError(f"{name}: unrecognized encrypted export")
    return AESGCM(key).decrypt(blob[5:17], blob[17:], name.encode())


def read_exports() -> tuple[bytes, bytes, bytes]:
    key = (BACKUP_DIR / "backup.key").read_bytes()
    if len(key) != 32:
        raise ValueError("Backup key has an unexpected length")
    return tuple(decrypt_export(name, key) for name in ("roles", "schema", "data"))


def omit_reserved_role_setting(roles: bytes) -> bytes:
    """Leave the destination's provider-owned supabase_admin settings intact."""
    lines = roles.splitlines(keepends=True)
    matches = [line for line in lines if line.strip() == RESERVED_ROLE_SETTING]
    if len(matches) != 1:
        raise ValueError("Expected exactly one provider-managed role setting")
    return b"".join(line for line in lines if line.strip() != RESERVED_ROLE_SETTING)


def read_rootcert() -> Path:
    raw = input("Full path to disposable project's downloaded SSL CA certificate: ").strip()
    rootcert = Path(raw).expanduser().resolve(strict=True)
    if not rootcert.is_file() or b"-----BEGIN CERTIFICATE-----" not in rootcert.read_bytes():
        raise ValueError("Expected a readable PEM certificate file")
    return rootcert


def connect(password: str, rootcert: Path, *, readonly: bool):
    connection = psycopg2.connect(
        host=DESTINATION_HOST,
        port=5432,
        user=f"postgres.{DESTINATION_REF}",
        password=password,
        dbname="postgres",
        sslmode="verify-full",
        sslrootcert=str(rootcert),
        connect_timeout=15,
    )
    if readonly:
        connection.set_session(readonly=True)
    return connection


def counts(password: str, rootcert: Path) -> tuple[int, int, bool, int, str]:
    connection = connect(password, rootcert, readonly=True)
    try:
        with connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT count(*) FROM auth.users")
                auth_users = cursor.fetchone()[0]
                cursor.execute(
                    "SELECT count(*) FROM information_schema.tables "
                    "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
                )
                public_tables = cursor.fetchone()[0]
                cursor.execute("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL")
                ledger_exists = cursor.fetchone()[0]
                ledger_count = 0
                if ledger_exists:
                    cursor.execute("SELECT count(*) FROM drizzle.__drizzle_migrations")
                    ledger_count = cursor.fetchone()[0]
                cursor.execute("SELECT current_setting('server_version')")
                version = cursor.fetchone()[0]
        return auth_users, public_tables, ledger_exists, ledger_count, version
    finally:
        connection.close()


def save_diagnostics(stdout: bytes, stderr: bytes) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = BACKUP_DIR / f"managed-restore-{timestamp}.log"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(stdout)
        handle.write(b"\n--- stderr ---\n")
        handle.write(stderr)
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check-archive", action="store_true", help="Authenticate exports without connecting"
    )
    args = parser.parse_args()
    os.umask(0o077)

    try:
        roles, schema, data = read_exports()
        roles = omit_reserved_role_setting(roles)
    except Exception as exc:
        print(f"Encrypted export check failed: {type(exc).__name__}")
        return 1
    print("Encrypted roles, schema and data exports authenticated.")
    print("Provider-managed supabase_admin timeout setting omitted from restore stream.")
    if args.check_archive:
        return 0

    if not sys.stdin.isatty():
        print("Run this script in an interactive Terminal; no database input was read.")
        return 2
    try:
        with open("/dev/tty", "rb") as tty:
            termios.tcgetattr(tty.fileno())
    except (OSError, termios.error):
        print("Terminal cannot hide password input; no database input was read.")
        return 2

    print(f"Fixed disposable Session pooler host: {DESTINATION_HOST}")
    try:
        rootcert = read_rootcert()
    except Exception as exc:
        print(f"Certificate check failed: {type(exc).__name__}")
        return 2
    password = getpass.getpass("Disposable project database password (hidden): ")
    try:
        before = counts(password, rootcert)
        print(
            "Destination before restore: "
            f"PostgreSQL {before[4]}; Auth users={before[0]}; "
            f"public tables={before[1]}; ledger exists={before[2]}"
        )
        if not before[4].startswith("17.") or before[:3] != (0, 0, False):
            print("Stopped: destination is not the verified empty PostgreSQL 17 project.")
            return 2

        confirmation = input(f"Type RESTORE {DESTINATION_REF} to continue: ").strip()
        if confirmation != f"RESTORE {DESTINATION_REF}":
            print("Restore cancelled; destination unchanged.")
            return 2

        sql = (
            roles
            + b"\n"
            + schema
            + b"\nSET session_replication_role = replica;\n"
            + data
            + b"\nSET session_replication_role = origin;\n"
        )
        command = [
            "psql", "-X", "-q", "--single-transaction", "-v", "ON_ERROR_STOP=1",
            "-h", DESTINATION_HOST, "-p", "5432", "-U", f"postgres.{DESTINATION_REF}",
            "-d", "postgres", "-f", "-",
        ]
        child_env = os.environ.copy()
        child_env["PGPASSWORD"] = password
        child_env["PGSSLMODE"] = "verify-full"
        child_env["PGSSLROOTCERT"] = str(rootcert)
        child_env["PGCONNECT_TIMEOUT"] = "15"
        started = time.monotonic()
        result = subprocess.run(
            command, input=sql, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=child_env, check=False,
        )
        log_path = save_diagnostics(result.stdout, result.stderr)
        print(f"Restore command exited {result.returncode} in {time.monotonic()-started:.1f}s.")
        print(f"Private diagnostics: {log_path}")
        if result.returncode:
            print("Restore failed; do not retry or edit the destination yet.")
            return result.returncode

        after = counts(password, rootcert)
        print(
            "Destination after restore: "
            f"Auth users={after[0]}; public tables={after[1]}; "
            f"ledger exists={after[2]}; ledger entries={after[3]}"
        )
        if after[0] != 5 or after[3] != 10:
            print("Counts differ from the backup checkpoint; investigate before proceeding.")
            return 3
        return 0
    except Exception as exc:
        print(f"Connection or verification failed: {type(exc).__name__}")
        return 1
    finally:
        password = None


if __name__ == "__main__":
    raise SystemExit(main())
