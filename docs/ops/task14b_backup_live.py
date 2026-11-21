#!/usr/bin/env python3
"""Read-only live pre-0029 backup, encrypted before any archive reaches disk.

Run on the founder's Mac with /usr/local/bin/python3. This never applies SQL.
"""

import hashlib
import os
import secrets
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from task14a_backup_live import ROOT_CERT, inspect, private_write, seal, source_connection


PROJECT_REF = "uqqpnsbpbkmdxzodwmqg"
BACKUP_DIR = Path.home() / "AIProjects" / "_task14b_backup_20261121"
POLICY_TABLES = (
    "ai_sessions", "ai_session_repositories", "ai_session_usage",
    "ai_commit_sessions", "scm_commits", "scm_commit_files",
    "scm_pull_request_commits", "scm_repositories", "scm_pull_requests",
    "scm_contributors", "scm_branches",
)


def policy_state(connection):
    db = psycopg2.connect(
        host=connection["host"], port=connection["port"],
        user=connection["user"], password=connection["password"],
        dbname=connection["dbname"], sslmode="verify-full",
        sslrootcert=str(ROOT_CERT), connect_timeout=15,
    )
    try:
        db.set_session(readonly=True)
        with db, db.cursor() as cursor:
            cursor.execute(
                "SELECT tablename, policyname FROM pg_policies "
                "WHERE schemaname='public' AND tablename = ANY(%s) "
                "AND policyname = tablename || '_tenant_select'",
                (list(POLICY_TABLES),),
            )
            policies = set(cursor.fetchall())
            cursor.execute(
                "SELECT c.relname FROM pg_class c JOIN pg_namespace n "
                "ON n.oid=c.relnamespace WHERE n.nspname='public' "
                "AND c.relrowsecurity"
            )
            rls = {row[0] for row in cursor.fetchall()}
            cursor.execute(
                "SELECT has_column_privilege('anon','public.sso_tenants','domain','SELECT'), "
                "has_column_privilege('anon','public.sso_tenants','supabase_provider_id','SELECT')"
            )
            login = cursor.fetchone()
        return policies, rls, login
    finally:
        db.close()


def main():
    os.umask(0o077)
    connection = source_connection()
    if connection["ref"] != PROJECT_REF:
        raise ValueError("Unexpected project reference")
    before = inspect(connection)
    policies, rls, login = policy_state(connection)
    expected = {(table, table + "_tenant_select") for table in POLICY_TABLES[:7]}
    if not str(before[0]).startswith("17.6") or before[2:] != (84, 29):
        raise ValueError("Unexpected live 0028 checkpoint")
    if policies != expected or not set(POLICY_TABLES).issubset(rls) or login != (True, True):
        raise ValueError("Unexpected live policy, RLS or login configuration")
    print("Verified live 0028 checkpoint and seven-policy shape; no SQL written.")

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
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=child_env, check=False,
    )
    if result.returncode:
        raise RuntimeError(f"pg_dump exited {result.returncode}; details withheld")
    archive = result.stdout
    listing = subprocess.run(
        ["pg_restore", "--list"], input=archive,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
    )
    if listing.returncode:
        raise ValueError("pg_restore could not list the dump")
    if inspect(connection)[1:] != before[1:] or policy_state(connection) != (policies, rls, login):
        raise ValueError("Live checkpoint changed during backup")

    key, nonce = secrets.token_bytes(32), secrets.token_bytes(12)
    encrypted = seal(archive, key, nonce)
    BACKUP_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    if BACKUP_DIR.stat().st_mode & 0o077:
        raise ValueError("Backup directory has group or other permissions")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    key_path = BACKUP_DIR / f"pre0029-{stamp}.key"
    archive_path = BACKUP_DIR / f"pre0029-{stamp}.dump.gcm"
    private_write(key_path, key)
    private_write(archive_path, encrypted)
    saved = archive_path.read_bytes()
    if AESGCM(key_path.read_bytes()).decrypt(saved[8:20], saved[20:], None) != archive:
        raise ValueError("Saved encrypted archive failed readback")
    print(f"Verified encrypted backup: {archive_path}")
    print(f"Local key: {key_path}")
    print(f"Archive SHA-256: {hashlib.sha256(saved).hexdigest()}")
    print("No plaintext dump was written to disk; no database write was made.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Backup stopped: {type(exc).__name__}; inspect before retry.")
        raise SystemExit(1)
