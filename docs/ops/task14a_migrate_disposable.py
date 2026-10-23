#!/usr/bin/env python3
"""Rehearse pending Drizzle migrations on Task14a's disposable Supabase copy.

Run in an interactive Terminal. The project reference and session-pooler host
are fixed below. The source/live project is never contacted by this script.
"""

import getpass
import json
import os
import re
import subprocess
import sys
import termios
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from task14a_restore_disposable import BACKUP_DIR, DESTINATION_REF, connect, counts


ROOT = Path(__file__).resolve().parents[2]
DESTINATION_HOST = "aws-0-ap-northeast-1.pooler.supabase.com"


def expected_timestamps() -> tuple[int, int]:
    journal = json.loads((ROOT / "apps/api/drizzle/meta/_journal.json").read_text())
    entries = journal["entries"]
    if len(entries) != 29 or entries[9]["tag"] != "0009_mute_tiger_shark":
        raise ValueError("Unexpected migration journal")
    return entries[9]["when"], entries[-1]["when"]


def migration_state(password: str) -> tuple[int, int, int, bool, int, str | None]:
    connection = connect(DESTINATION_HOST, password, readonly=True)
    try:
        with connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT count(*), max(created_at) FROM drizzle.__drizzle_migrations"
                )
                ledger_count, last_timestamp = cursor.fetchone()
                cursor.execute("SELECT count(*) FROM auth.users")
                auth_users = cursor.fetchone()[0]
                cursor.execute("SELECT pg_has_role(current_user, 'trackai_audit_reader', 'MEMBER')")
                member = cursor.fetchone()[0]
                cursor.execute(
                    "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' "
                    "AND policyname IN ('security_audit_events_audit_reader_select', "
                    "'attesta_audit_seals_audit_reader_select')"
                )
                policies = cursor.fetchone()[0]
                cursor.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
                vector_row = cursor.fetchone()
        return ledger_count, last_timestamp, auth_users, member, policies, (
            vector_row[0] if vector_row else None
        )
    finally:
        connection.close()


def last_migration_timestamp(password: str) -> int:
    connection = connect(DESTINATION_HOST, password, readonly=True)
    try:
        with connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT max(created_at) FROM drizzle.__drizzle_migrations")
                return cursor.fetchone()[0]
    finally:
        connection.close()


def save_log(name: str, result: subprocess.CompletedProcess) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = BACKUP_DIR / f"managed-{name}-{timestamp}.log"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(result.stdout)
        handle.write(b"\n--- stderr ---\n")
        handle.write(result.stderr)
    return path


def run_logged(name: str, command: list[str], env: dict[str, str]):
    started = time.monotonic()
    result = subprocess.run(
        command, cwd=ROOT, env=env, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=False,
    )
    path = save_log(name, result)
    print(f"{name}: exit={result.returncode}, elapsed={time.monotonic()-started:.1f}s; private log={path}")
    return result


def main() -> int:
    os.umask(0o077)
    if not sys.stdin.isatty():
        print("Run in an interactive Terminal; no password was read.")
        return 2
    try:
        with open("/dev/tty", "rb") as tty:
            termios.tcgetattr(tty.fileno())
    except (OSError, termios.error):
        print("Terminal cannot hide password input; no password was read.")
        return 2

    password = getpass.getpass("Disposable project database password (hidden): ")
    try:
        original_timestamp, target_timestamp = expected_timestamps()
        before = counts(DESTINATION_HOST, password)
        print(
            "Destination before migration: "
            f"PostgreSQL {before[4]}; Auth users={before[0]}; "
            f"public tables={before[1]}; ledger entries={before[3]}"
        )
        if not before[4].startswith("17.") or before[:4] != (5, 42, True, 10):
            print("Stopped: destination is not the restored 0009 checkpoint.")
            return 2
        if last_migration_timestamp(password) != original_timestamp:
            print("Stopped: last migration timestamp differs from 0009.")
            return 2

        if input(f"Type MIGRATE {DESTINATION_REF} to continue: ").strip() != f"MIGRATE {DESTINATION_REF}":
            print("Migration cancelled; destination unchanged.")
            return 2

        username = f"postgres.{DESTINATION_REF}"
        url = (
            f"postgresql://{quote(username, safe='')}:{quote(password, safe='')}"
            f"@{DESTINATION_HOST}:5432/postgres?sslmode=require"
        )
        env = os.environ.copy()
        env["DATABASE_URL"] = url
        env.pop("TASK4_WAVE5_PENDING_RECONCILE_APPLY", None)
        env.pop("TASK5_EPHEMERAL_DATABASE", None)
        env.pop("TASK6_EPHEMERAL_DATABASE", None)
        migration = run_logged(
            "migrate", ["npm", "run", "db:migrate", "-w", "apps/api"], env
        )
        if migration.returncode:
            print("Migration failed; do not retry or edit the destination yet.")
            return migration.returncode

        after = migration_state(password)
        print(
            "Destination after migration: "
            f"ledger={after[0]}; Auth users={after[2]}; "
            f"audit membership={after[3]}; audit policies={after[4]}; "
            f"vector={after[5] or 'absent'}"
        )
        if after[:5] != (29, target_timestamp, 5, True, 2) or not after[5]:
            print("Post-migration checks differ; stop before any further step.")
            return 3

        dry_runs = [
            ("task19g-dry-run", ["npm", "run", "backfill:task19g-merged-by", "-w", "apps/api"]),
            ("task4-dry-run", ["npm", "run", "reconcile:task4-wave5-pending", "-w", "apps/api"]),
            ("security-seal-dry-run", ["npm", "run", "attesta:security-seal", "-w", "apps/api", "--", "--now"]),
        ]
        for name, command in dry_runs:
            result = run_logged(name, command, env)
            if result.returncode:
                print("A post-step dry run failed; do not use an apply flag.")
                return result.returncode
            output = result.stdout.decode(errors="replace")
            if name == "task19g-dry-run":
                values = [int(x) for x in re.findall(r'"would_update":(\d+)', output)]
                summary = f"tenants={len(values)}, candidates={sum(values)}"
                dry_run_verified = bool(values) and output.count('"dry_run":true') == len(values)
            elif name == "task4-dry-run":
                selected = re.search(r"^selected_rows=(\d+)", output, re.M)
                changed = re.search(r"^database_changes=(\d+)", output, re.M)
                summary = (
                    f"selected={selected.group(1) if selected else '?'}; "
                    f"changes={changed.group(1) if changed else '?'}"
                )
                dry_run_verified = "mode=dry-run" in output
            else:
                dry_run_verified = "mode=dry-run" in output
                summary = f"dry-run flag present={dry_run_verified}"
            print(f"{name}: {summary}")
            if not dry_run_verified:
                print("Dry-run output could not be verified; stop here.")
                return 3
        return 0
    except Exception as exc:
        print(f"Connection or verification failed: {type(exc).__name__}")
        return 1
    finally:
        password = None


if __name__ == "__main__":
    raise SystemExit(main())
