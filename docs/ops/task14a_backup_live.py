#!/usr/bin/env python3
"""Take a fresh, encrypted, read-only pre-0010 backup of Task14a's live DB.

Uses the already verified API DATABASE_URL only to identify the project and
obtain its password. The dump runs through the session pooler with verified
TLS. Plaintext stays in process memory. Never run after migration 0010.
"""

import argparse
import hashlib
import os
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

import psycopg2
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


SOURCE_ENV = Path("/Users/manishmahajan/AIProjects/TrackAI-v1/apps/api/.env")
ROOT_CERT = Path("/Users/manishmahajan/Downloads/prod-ca-2021.crt")
ARCHIVE_DIR = Path.home() / "Documents" / "TrackAI-Task14a-backups"
KEY_DIR = Path("/Users/manishmahajan/AIProjects/_task14a_backup_20261024")
DISPOSABLE_REF = "glwwxaobocwoczvjmrod"
MAGIC = b"T14AGCM1"


def source_connection() -> dict[str, object]:
    lines = SOURCE_ENV.read_text().splitlines()
    values = [line.partition("=")[2].strip().strip('"').strip("'")
              for line in lines if line.startswith("DATABASE_URL=")]
    if len(values) != 1:
        raise ValueError("Expected one live DATABASE_URL")
    parsed = urlsplit(values[0])
    if parsed.scheme not in ("postgresql", "postgres"):
        raise ValueError("Expected a PostgreSQL URL")
    if parsed.port != 6543 or not parsed.hostname or not parsed.hostname.endswith(
        ".pooler.supabase.com"
    ):
        raise ValueError("Expected the verified transaction pooler URL")
    user = unquote(parsed.username or "")
    password = unquote(parsed.password or "")
    if not user.startswith("postgres.") or not password or parsed.path != "/postgres":
        raise ValueError("Expected a project-scoped postgres login")
    ref = user.removeprefix("postgres.")
    if ref == DISPOSABLE_REF or not ref.isalnum() or len(ref) != 20:
        raise ValueError("Refused disposable or malformed project reference")
    if not ROOT_CERT.is_file() or b"BEGIN CERTIFICATE" not in ROOT_CERT.read_bytes():
        raise ValueError("Missing Supabase CA certificate")
    return {"host": parsed.hostname, "port": 5432, "user": user,
            "password": password, "dbname": "postgres", "ref": ref}


def inspect(connection: dict[str, object]) -> tuple[str, int, int, int]:
    db = psycopg2.connect(
        host=connection["host"], port=connection["port"],
        user=connection["user"], password=connection["password"],
        dbname=connection["dbname"], sslmode="verify-full",
        sslrootcert=str(ROOT_CERT), connect_timeout=15,
    )
    try:
        db.set_session(readonly=True)
        with db:
            with db.cursor() as cursor:
                cursor.execute("SELECT current_setting('server_version')")
                version = cursor.fetchone()[0]
                cursor.execute("SELECT count(*) FROM auth.users")
                auth_users = cursor.fetchone()[0]
                cursor.execute(
                    "SELECT count(*) FROM information_schema.tables "
                    "WHERE table_schema='public' AND table_type='BASE TABLE'"
                )
                public_tables = cursor.fetchone()[0]
                cursor.execute("SELECT count(*) FROM drizzle.__drizzle_migrations")
                ledger = cursor.fetchone()[0]
        return version, auth_users, public_tables, ledger
    finally:
        db.close()


def seal(data: bytes, key: bytes, nonce: bytes) -> bytes:
    if not data.startswith(b"PGDMP"):
        raise ValueError("Expected a PostgreSQL custom-format archive")
    return MAGIC + nonce + AESGCM(key).encrypt(nonce, data, None)


def private_write(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inspect", action="store_true", help="read-only target check")
    parser.add_argument("--self-test", action="store_true", help="test archive sealing")
    args = parser.parse_args()
    os.umask(0o077)
    if args.self_test:
        sample = b"PGDMP" + secrets.token_bytes(256)
        key, nonce = secrets.token_bytes(32), secrets.token_bytes(12)
        blob = seal(sample, key, nonce)
        assert AESGCM(key).decrypt(blob[8:20], blob[20:], None) == sample
        print("Backup encryption self-test passed.")
        return 0
    try:
        connection = source_connection()
        before = inspect(connection)
        print(
            f"Verified live target: PostgreSQL {before[0]}; Auth users={before[1]}; "
            f"public tables={before[2]}; ledger entries={before[3]}."
        )
        if not before[0].startswith("17.6") or before[1:] != (5, 42, 10):
            print("Unexpected pre-0010 checkpoint; backup stopped.")
            return 2
        if args.inspect:
            print("Read-only inspection complete; no backup was written.")
            return 0
        if not sys.stdin.isatty():
            print("Run interactively in Terminal to confirm the live source.")
            return 2
        ref = connection["ref"]
        if input(f"Type BACKUP {ref} to continue: ").strip() != f"BACKUP {ref}":
            print("Backup cancelled.")
            return 2
        child_env = os.environ.copy()
        child_env.update({
            "PGHOST": str(connection["host"]), "PGPORT": "5432",
            "PGUSER": str(connection["user"]),
            "PGPASSWORD": str(connection["password"]),
            "PGDATABASE": "postgres", "PGSSLMODE": "verify-full",
            "PGSSLROOTCERT": str(ROOT_CERT),
        })
        result = subprocess.run(
            ["pg_dump", "--format=custom", "--no-password", "--lock-wait-timeout=10s"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=child_env,
            check=False,
        )
        if result.returncode:
            print(f"pg_dump failed (exit {result.returncode}); diagnostic output withheld.")
            return 3
        archive_data = result.stdout
        key, nonce = secrets.token_bytes(32), secrets.token_bytes(12)
        encrypted = seal(archive_data, key, nonce)
        if AESGCM(key).decrypt(encrypted[8:20], encrypted[20:], None) != archive_data:
            raise ValueError("Encrypted archive failed authenticated readback")
        after = inspect(connection)
        if after[3] != 10:
            print("Live migration ledger changed during backup; archive not saved.")
            return 3
        ARCHIVE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        archive_path = ARCHIVE_DIR / f"supabase_pre0010_full_{stamp}.dump.gcm"
        key_path = KEY_DIR / f"backup-{stamp}.key"
        if not KEY_DIR.is_dir():
            raise ValueError("Private key directory is missing")
        private_write(archive_path, encrypted)
        private_write(key_path, key)
        saved = archive_path.read_bytes()
        if AESGCM(key_path.read_bytes()).decrypt(saved[8:20], saved[20:], None) != archive_data:
            raise ValueError("Saved archive failed authenticated readback")
        print(f"Encrypted archive: {archive_path}")
        print(f"Local key: {key_path}")
        print(f"Archive bytes={len(saved)}; SHA-256={hashlib.sha256(saved).hexdigest()}")
        print("Plaintext dump was never written to disk; live database was read only.")
        return 0
    except Exception as exc:
        print(f"Backup stopped: {type(exc).__name__}; no database write was made.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
