#!/usr/bin/env python3
"""Guarded Task14a live migration through Supabase's verified session pooler.

`--inspect` is read only. `--apply` requires both a verified 0009 checkpoint
and an interactive confirmation, then applies 0010-0028 once. Do not invoke
`--apply` before the founder separately approves this exact live operation.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import psycopg2
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from task14a_backup_live import (
    ARCHIVE_DIR, KEY_DIR, MAGIC, ROOT_CERT, inspect, source_connection,
)


ROOT = Path(__file__).resolve().parents[2]
BACKUP_STAMP = "20261024T093051Z"
ARCHIVE = ARCHIVE_DIR / f"supabase_pre0010_full_{BACKUP_STAMP}.dump.gcm"
KEY = KEY_DIR / f"backup-{BACKUP_STAMP}.key"
EXPECTED_BACKUP_SHA256 = "3a1327572aeb1669de6902e72612f2c27c674dd2c0a50a579ab47ea012bb1dfc"
EXPECTED_0024_SHA256 = "b41314b8b63d45ebd2276e360637e1082e247a25b4c95b5c83c9042698306061"


def check_reviewed_inputs() -> None:
    migration = ROOT / "apps/api/drizzle/0024_audit_db_role.sql"
    if hashlib.sha256(migration.read_bytes()).hexdigest() != EXPECTED_0024_SHA256:
        raise ValueError("Corrected 0024 hash differs from reviewed version")
    key, blob = KEY.read_bytes(), ARCHIVE.read_bytes()
    if len(key) != 32 or blob[:8] != MAGIC:
        raise ValueError("Fresh backup format mismatch")
    if hashlib.sha256(blob).hexdigest() != EXPECTED_BACKUP_SHA256:
        raise ValueError("Fresh backup hash mismatch")
    if not AESGCM(key).decrypt(blob[8:20], blob[20:], None).startswith(b"PGDMP"):
        raise ValueError("Fresh backup content mismatch")


def timestamps() -> tuple[int, int]:
    journal = json.loads((ROOT / "apps/api/drizzle/meta/_journal.json").read_text())
    entries = journal["entries"]
    if (len(entries) != 29 or entries[9]["tag"] != "0009_mute_tiger_shark"
            or entries[-1]["tag"] != "0028_friendly_mystique"):
        raise ValueError("Unexpected migration journal")
    return entries[9]["when"], entries[-1]["when"]


def state(connection: dict[str, object]) -> tuple[int, int | None, bool, int, str | None, bool]:
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
                cursor.execute("SELECT count(*), max(created_at) FROM drizzle.__drizzle_migrations")
                ledger, latest = cursor.fetchone()
                cursor.execute(
                    "SELECT CASE WHEN to_regrole('trackai_audit_reader') IS NULL "
                    "THEN false ELSE pg_has_role(current_user, 'trackai_audit_reader', 'MEMBER') END"
                )
                member = cursor.fetchone()[0]
                cursor.execute(
                    "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND "
                    "policyname IN ('security_audit_events_audit_reader_select', "
                    "'attesta_audit_seals_audit_reader_select')"
                )
                policies = cursor.fetchone()[0]
                cursor.execute("SELECT extversion FROM pg_extension WHERE extname='vector'")
                version = cursor.fetchone()
                cursor.execute(
                    "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                    "WHERE n.nspname='public' AND c.relname IN "
                    "('security_audit_events','attesta_audit_seals') AND c.relrowsecurity"
                )
                rls = cursor.fetchone()[0] == 2
        return ledger, latest, member, policies, version[0] if version else None, rls
    finally:
        db.close()


def database_url(connection: dict[str, object]) -> str:
    return (
        f"postgresql://{quote(str(connection['user']), safe='')}:"
        f"{quote(str(connection['password']), safe='')}@{connection['host']}:5432/postgres"
        f"?sslmode=verify-full&sslrootcert={quote(str(ROOT_CERT), safe='')}"
    )


def run_logged(label: str, command: list[str], environment: dict[str, str]) -> tuple[int, Path]:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = KEY_DIR / f"live-{label}-{stamp}.log"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    started = time.monotonic()
    with os.fdopen(fd, "wb") as log:
        result = subprocess.run(
            command, cwd=ROOT, env=environment, stdout=log,
            stderr=subprocess.STDOUT, check=False,
        )
    print(f"{label}: exit={result.returncode}; elapsed={time.monotonic()-started:.1f}s; private log={path}")
    return result.returncode, path


def dry_runs(environment: dict[str, str]) -> int:
    jobs = (
        ("task19g-dry-run", ["npm", "run", "backfill:task19g-merged-by", "-w", "apps/api"]),
        ("task4-dry-run", ["npm", "run", "reconcile:task4-wave5-pending", "-w", "apps/api"]),
        ("security-seal-dry-run", ["npm", "run", "attesta:security-seal", "-w", "apps/api", "--", "--now"]),
    )
    for name, command in jobs:
        code, path = run_logged(name, command, environment)
        output = path.read_text(errors="replace")
        if name == "task19g-dry-run":
            values = [int(x) for x in re.findall(r'"would_update":(\d+)', output)]
            verified = bool(values) and output.count('"dry_run":true') == len(values)
            summary = f"tenants={len(values)}, candidates={sum(values)}"
        elif name == "task4-dry-run":
            selected = re.search(r"^selected_rows=(\d+)", output, re.M)
            changes = re.search(r"^database_changes=([a-z0-9_-]+)$", output, re.M)
            verified = "mode=dry-run" in output and bool(selected and changes)
            summary = f"selected={selected.group(1) if selected else '?'}, changes={changes.group(1) if changes else '?'}"
        else:
            verified = "mode=dry-run" in output
            summary = f"dry-run={verified}"
        print(f"{name}: {summary}")
        if code or not verified:
            print("Post-step dry run failed; no apply flag was used.")
            return 3
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--inspect", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--poststeps", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        connection = source_connection()
        before = inspect(connection)
        before_state = state(connection)
        print(
            f"Live state: PostgreSQL {before[0]}; Auth users={before[1]}; "
            f"public tables={before[2]}; ledger={before_state[0]}; "
            f"audit membership={before_state[2]}; policies={before_state[3]}; "
            f"vector={before_state[4] or 'absent'}"
        )
        initial, target = timestamps()
        if args.inspect:
            print("Read-only inspection complete; no migration was run.")
            return 0
        if not before[0].startswith("17.6") or before[1] != 5:
            print("Unexpected live version or Auth checkpoint; stopped.")
            return 2
        environment = os.environ.copy()
        environment["DATABASE_URL"] = database_url(connection)
        for name in ("TASK4_WAVE5_PENDING_RECONCILE_APPLY", "TASK5_EPHEMERAL_DATABASE", "TASK6_EPHEMERAL_DATABASE"):
            environment.pop(name, None)
        if args.poststeps:
            if before[2:] != (84, 29) or before_state != (29, target, True, 2, "0.8.2", True):
                print("Live target is not the verified 0028 checkpoint; stopped.")
                return 2
            result = dry_runs(environment)
            if result:
                return result
            if inspect(connection)[2:] != (84, 29):
                print("Post-step checkpoint changed; stopped.")
                return 3
            print("All three live default dry runs passed; no apply flags used.")
            return 0
        if before[2:] != (42, 10) or before_state[0:2] != (10, initial):
            print("Live target is not the verified 0009 checkpoint; stopped.")
            return 2
        if not ARCHIVE.is_file() or not KEY.is_file():
            print("Fresh encrypted backup or key missing; stopped.")
            return 2
        check_reviewed_inputs()
        print("Reviewed 0024 hash and fresh encrypted backup authenticated.")
        if not sys.stdin.isatty():
            print("Run interactively in Terminal for live-apply confirmation.")
            return 2
        ref = connection["ref"]
        if input(f"Type MIGRATE {ref} to apply 0010-0028 LIVE: ").strip() != f"MIGRATE {ref}":
            print("Live migration cancelled.")
            return 2
        code, _ = run_logged("migrate", ["npm", "run", "db:migrate", "-w", "apps/api"], environment)
        if code:
            print("Migration command failed; inspect live state before any retry.")
            return code
        after = inspect(connection)
        after_state = state(connection)
        print(
            f"Live postflight: Auth users={after[1]}; public tables={after[2]}; "
            f"ledger={after_state[0]}; audit membership={after_state[2]}; "
            f"policies={after_state[3]}; vector={after_state[4] or 'absent'}; "
            f"audit RLS={after_state[5]}"
        )
        if after[2:] != (84, 29) or after_state != (29, target, True, 2, "0.8.2", True):
            print("Live postflight differs; stop before further steps.")
            return 3
        print("Live 0010-0028 migration applied; run --poststeps next.")
        return 0
    except Exception as exc:
        print(f"Live operation stopped: {type(exc).__name__}; inspect state before retry.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
