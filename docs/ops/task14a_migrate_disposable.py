#!/usr/bin/env python3
"""Rehearse pending Drizzle migrations on Task14a's disposable Supabase copy.

Run in an interactive Terminal. The project reference and session-pooler host
are fixed below. The source/live project is never contacted by this script.
"""

import argparse
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

import psycopg2

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


def probe_migrations(password: str) -> int:
    """Execute the pending Drizzle statements in one transaction, then roll back."""
    journal = json.loads((ROOT / "apps/api/drizzle/meta/_journal.json").read_text())
    connection = connect(DESTINATION_HOST, password, readonly=False)
    failure = None
    migration_tag = "none"
    statement_number = 0
    try:
        with connection.cursor() as cursor:
            cursor.execute("SET LOCAL lock_timeout = '5s'")
            cursor.execute("SET LOCAL statement_timeout = '30s'")
            for entry in journal["entries"][10:]:
                migration_tag = entry["tag"]
                sql = (ROOT / "apps/api/drizzle" / f"{migration_tag}.sql").read_text()
                for statement_number, statement in enumerate(
                    sql.split("--> statement-breakpoint"), start=1
                ):
                    cursor.execute(statement)
    except psycopg2.Error as exc:
        failure = (exc.pgcode or "connection_error", type(exc).__name__,
                   str(exc), migration_tag, statement_number)
    finally:
        try:
            connection.rollback()
        finally:
            connection.close()

    after = counts(DESTINATION_HOST, password)
    original_timestamp, _ = expected_timestamps()
    unchanged = after[:4] == (5, 42, True, 10) and (
        last_migration_timestamp(password) == original_timestamp
    )
    if not unchanged:
        print("Post-probe checkpoint differs; stop and investigate.")
        return 3
    if failure is None:
        print("Rollback-only probe passed all pending statements; destination remains at 0009.")
        return 0

    code, error_class, message, migration_tag, statement_number = failure
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    log_path = BACKUP_DIR / f"managed-probe-{timestamp}.log"
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(
            f"migration={migration_tag}\nstatement={statement_number}\n"
            f"sqlstate={code}\nerror_class={error_class}\nmessage={message}\n"
        )
    print(
        f"Rollback-only probe stopped at {migration_tag}, statement "
        f"{statement_number}; SQLSTATE={code}; error={error_class}."
    )
    print(f"Private diagnostics: {log_path}")
    print("Destination remains at 0009; do not run MIGRATE yet.")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--inspect", action="store_true",
        help="Read destination state only; never run migrations or post-steps",
    )
    mode.add_argument(
        "--probe", action="store_true",
        help="Run pending SQL in one transaction, then roll back",
    )
    args = parser.parse_args()
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
            "Disposable destination state: "
            f"PostgreSQL {before[4]}; Auth users={before[0]}; "
            f"public tables={before[1]}; ledger entries={before[3]}"
        )
        if args.inspect:
            last = last_migration_timestamp(password) if before[2] else None
            print(
                "Last Drizzle migration: "
                + ("0009 checkpoint" if last == original_timestamp else
                   "0028 target" if last == target_timestamp else "other or absent")
            )
            print("Read-only inspection complete; no migration was run.")
            return 0
        if not before[4].startswith("17.") or before[:4] != (5, 42, True, 10):
            print("Stopped: destination is not the restored 0009 checkpoint.")
            return 2
        if last_migration_timestamp(password) != original_timestamp:
            print("Stopped: last migration timestamp differs from 0009.")
            return 2

        if args.probe:
            if input(f"Type PROBE {DESTINATION_REF} to continue: ").strip() != f"PROBE {DESTINATION_REF}":
                print("Probe cancelled; destination unchanged.")
                return 2
            return probe_migrations(password)

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
