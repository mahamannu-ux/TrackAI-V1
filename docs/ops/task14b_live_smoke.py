#!/usr/bin/env python3
"""Start a separate live smoke API or web process without changing Task20j."""

import argparse
import getpass
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

from task14a_backup_live import SOURCE_ENV, source_connection


ROOT = Path(__file__).resolve().parents[2]
PROJECT_REF = "uqqpnsbpbkmdxzodwmqg"


def api_environment():
    connection = source_connection()
    if connection["ref"] != PROJECT_REF:
        raise ValueError("Unexpected live database project")
    env = os.environ.copy()
    for line in SOURCE_ENV.read_text().splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError("Malformed environment variable name")
        env[key] = value.strip().strip('"').strip("'")
    supabase = urlsplit(env.get("SUPABASE_URL", ""))
    if supabase.scheme != "https" or supabase.hostname != f"{PROJECT_REF}.supabase.co":
        raise ValueError("Unexpected live Auth project")
    for key in ("TASK5_EPHEMERAL_DATABASE", "TASK6_EPHEMERAL_DATABASE",
                "TASK4_WAVE5_PENDING_RECONCILE_APPLY"):
        env.pop(key, None)
    env["PORT"] = "8082"
    env["FRONTEND_URL"] = "http://localhost:3002,http://127.0.0.1:3002"
    return env


def web_environment():
    key = getpass.getpass("Live project's publishable/anon key (hidden): ").strip()
    if not (key.startswith("sb_publishable_") or key.startswith("eyJ")):
        raise ValueError("Expected a Supabase publishable or legacy anon key")
    env = os.environ.copy()
    env["NEXT_PUBLIC_SUPABASE_URL"] = f"https://{PROJECT_REF}.supabase.co"
    env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = key
    env["NEXT_PUBLIC_API_URL"] = "http://127.0.0.1:8082"
    env["PORT"] = "3002"
    return env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("api", "web"))
    args = parser.parse_args()
    if not sys.stdin.isatty():
        raise ValueError("Run in an interactive Terminal")
    if args.mode == "api":
        env = api_environment()
        print("Starting live API on 8082 for the verified project; Ctrl-C stops it.")
        command = ["npm", "run", "dev:api"]
    else:
        env = web_environment()
        print("Starting live web on 3002 with live Supabase and API 8082; Ctrl-C stops it.")
        command = ["npm", "run", "dev:web"]
    os.chdir(ROOT)
    os.execvpe("npm", command, env)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Smoke process stopped: {type(exc).__name__}; no database migration was run.")
        raise SystemExit(1)
