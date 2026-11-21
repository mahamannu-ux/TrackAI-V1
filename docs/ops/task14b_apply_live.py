#!/usr/bin/env python3
"""Guarded one-time live application of Task14b migration 0029.

--inspect reads only. --apply requires a verified fresh backup and an
interactive confirmation. Never apply without the founder's separate approval.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from task14a_backup_live import ROOT_CERT, inspect, source_connection
from task14a_migrate_live import database_url
from task14b_backup_live import BACKUP_DIR, POLICY_TABLES, PROJECT_REF, policy_state


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "apps/api/drizzle/0029_task14b_data_api_policy_closure.sql"
JOURNAL = ROOT / "apps/api/drizzle/meta/_journal.json"
EXPECTED_SQL_SHA256 = "b3b9cb300c6c893d8491b26998f3151ec66a215177e66349406866c24c0055c1"
BACKUP_STAMP = "20261121T100607Z"
ARCHIVE = BACKUP_DIR / f"pre0029-{BACKUP_STAMP}.dump.gcm"
KEY = BACKUP_DIR / f"pre0029-{BACKUP_STAMP}.key"
EXPECTED_ARCHIVE_SHA256 = "4fdd71ee3e246f890d0264a6c1b10755f99145f288a5763f6fd1e3eb657f71b5"


def check_inputs():
    if hashlib.sha256(MIGRATION.read_bytes()).hexdigest() != EXPECTED_SQL_SHA256:
        raise ValueError("0029 differs from the reviewed SQL")
    entries = json.loads(JOURNAL.read_text())["entries"]
    if (len(entries) != 30 or entries[-2]["tag"] != "0028_friendly_mystique"
            or entries[-1]["tag"] != "0029_task14b_data_api_policy_closure"):
        raise ValueError("Migration journal differs from 0028 to 0029 only")
    migration_files = sorted(p.name for p in MIGRATION.parent.glob("[0-9][0-9][0-9][0-9]_*.sql"))
    if len(migration_files) != 30 or migration_files[-1] != MIGRATION.name:
        raise ValueError("Unexpected additional migration files")
    blob, key = ARCHIVE.read_bytes(), KEY.read_bytes()
    if len(key) != 32 or blob[:8] != b"T14AGCM1":
        raise ValueError("Fresh encrypted backup format mismatch")
    if hashlib.sha256(blob).hexdigest() != EXPECTED_ARCHIVE_SHA256:
        raise ValueError("Fresh encrypted backup hash mismatch")
    plaintext = AESGCM(key).decrypt(blob[8:20], blob[20:], None)
    if not plaintext.startswith(b"PGDMP"):
        raise ValueError("Fresh backup did not contain a PostgreSQL archive")
    listing = subprocess.run(["pg_restore", "--list"], input=plaintext,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             check=False)
    if listing.returncode:
        raise ValueError("Fresh backup cannot be listed by pg_restore")
    return entries[-2]["when"], entries[-1]["when"]


def live_state(connection):
    db = psycopg2.connect(
        host=connection["host"], port=connection["port"],
        user=connection["user"], password=connection["password"],
        dbname=connection["dbname"], sslmode="verify-full",
        sslrootcert=str(ROOT_CERT), connect_timeout=15,
    )
    try:
        db.set_session(readonly=True)
        with db, db.cursor() as cur:
            cur.execute("SELECT count(*), max(created_at) FROM drizzle.__drizzle_migrations")
            ledger = cur.fetchone()
            cur.execute(
                "SELECT policyname, roles, cmd, qual, with_check FROM pg_policies "
                "WHERE schemaname='public' AND tablename='sso_tenants' ORDER BY policyname"
            )
            login_policies = cur.fetchall()
        return ledger, login_policies
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--inspect", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    previous_when, target_when = check_inputs()
    connection = source_connection()
    if connection["ref"] != PROJECT_REF:
        raise ValueError("Unexpected live project reference")
    before = inspect(connection)
    (ledger, login_policies) = live_state(connection)
    policies, rls, login_columns = policy_state(connection)
    expected = {(table, table + "_tenant_select") for table in POLICY_TABLES[:7]}
    if not str(before[0]).startswith("17.6") or before[2] != 84:
        raise ValueError("Unexpected live PostgreSQL version or public table count")
    if ledger != (29, previous_when) or before[3] != 29 or policies != expected:
        raise ValueError("Live ledger or seven-policy checkpoint differs")
    if not set(POLICY_TABLES).issubset(rls) or login_columns != (True, True) or not login_policies:
        raise ValueError("RLS or anonymous login configuration differs")
    print("Verified 0028 ledger, seven policies, RLS, anonymous login and encrypted backup.")
    if args.inspect:
        print("Read-only preflight passed; no SQL was applied.")
        return
    if not sys.stdin.isatty():
        raise ValueError("Apply must run interactively in Terminal")
    if input(f"Type APPLY 0029 {PROJECT_REF} to change the LIVE database: ").strip() != f"APPLY 0029 {PROJECT_REF}":
        raise ValueError("Live migration cancelled")
    environment = os.environ.copy()
    environment["DATABASE_URL"] = database_url(connection)
    for name in ("TASK4_WAVE5_PENDING_RECONCILE_APPLY", "TASK5_EPHEMERAL_DATABASE", "TASK6_EPHEMERAL_DATABASE"):
        environment.pop(name, None)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    log_path = BACKUP_DIR / f"apply-{stamp}.log"
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    started = time.monotonic()
    with os.fdopen(fd, "wb") as log:
        result = subprocess.run(["npm", "run", "db:migrate", "-w", "apps/api"],
                                cwd=ROOT, env=environment, stdout=log,
                                stderr=subprocess.STDOUT, check=False)
    print(f"Drizzle exit={result.returncode}; elapsed={time.monotonic()-started:.1f}s; private log={log_path}")
    if result.returncode:
        raise RuntimeError("Migration failed; inspect live state before any retry")
    after = inspect(connection)
    after_ledger, after_login_policies = live_state(connection)
    after_policies, after_rls, after_login_columns = policy_state(connection)
    if (after[2:] != (84, 30) or after_ledger != (30, target_when)
            or after_policies or after_rls != rls
            or after_login_columns != login_columns
            or after_login_policies != login_policies):
        raise RuntimeError("Postflight differs; inspect live state before further action")
    print("Live 0029 applied: ledger=30; legacy policies=0; RLS and anonymous login unchanged.")
    print("Next: check Okta login and the protected API dashboard in the browser.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Task14b live operation stopped: {type(exc).__name__}; no automatic retry.")
        raise SystemExit(1)
