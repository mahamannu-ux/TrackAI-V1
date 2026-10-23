#!/usr/bin/env python3
"""Verify one restored Auth user in Task14a's disposable Supabase project.

The founder runs this in an interactive Terminal. It resets the password of
the sole email/password account in the disposable project, signs in, and
checks that Auth returns the same user. It never contacts the source project.
"""

import getpass
import os
import subprocess
import sys
import termios
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


DESTINATION_REF = "glwwxaobocwoczvjmrod"
BACKUP_DIR = Path("/Users/manishmahajan/AIProjects/_task14a_backup_20261024")


def restored_password_user() -> tuple[str, str]:
    key = (BACKUP_DIR / "backup.key").read_bytes()
    blob = (BACKUP_DIR / "data.sql.gcm").read_bytes()
    if len(key) != 32 or blob[:5] != b"T14A1":
        raise ValueError("Unrecognized encrypted backup")
    data = AESGCM(key).decrypt(blob[5:17], blob[17:], b"data")
    in_users = False
    matches = []
    for line in data.splitlines():
        if line.startswith(b'COPY "auth"."users" '):
            in_users = True
            continue
        if in_users and line == b"\\.":
            in_users = False
            continue
        if in_users:
            fields = line.split(b"\t")
            if len(fields) < 6:
                raise ValueError("Unexpected Auth user export")
            if fields[5] not in (b"\\N", b""):
                matches.append((fields[1].decode(), fields[4].decode()))
    if len(matches) != 1 or not all(matches[0]):
        raise ValueError("Expected exactly one restored email/password user")
    return matches[0]


NODE_CHECK = r"""
const { createClient } = require('@supabase/supabase-js');
const url = `https://${process.env.T14A_REF}.supabase.co`;
const opts = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
const admin = createClient(url, process.env.T14A_SECRET_KEY, opts);
const userClient = createClient(url, process.env.T14A_PUBLISHABLE_KEY, opts);
function fail(stage, error) {
  const code = error && typeof error.code === 'string' ? error.code : 'unknown';
  console.log(`Auth verification failed at ${stage}; code=${code}`);
  process.exit(1);
}
(async () => {
  const id = process.env.T14A_USER_ID;
  const email = process.env.T14A_EMAIL;
  const found = await admin.auth.admin.getUserById(id);
  if (found.error || found.data?.user?.id !== id || found.data?.user?.email?.toLowerCase() !== email.toLowerCase())
    fail('restored-user lookup', found.error);
  console.log('Restored user found by Auth Admin API.');

  const updated = await admin.auth.admin.updateUserById(id, {
    password: process.env.T14A_NEW_PASSWORD,
  });
  if (updated.error || updated.data?.user?.id !== id)
    fail('disposable password reset', updated.error);
  console.log('Disposable password reset succeeded.');

  const signed = await userClient.auth.signInWithPassword({
    email, password: process.env.T14A_NEW_PASSWORD,
  });
  if (signed.error || !signed.data?.session?.access_token || signed.data?.user?.id !== id)
    fail('password sign-in', signed.error);
  console.log('Restored user sign-in succeeded.');

  const checked = await userClient.auth.getUser(signed.data.session.access_token);
  if (checked.error || checked.data?.user?.id !== id)
    fail('signed-in user lookup', checked.error);
  console.log('Issued session resolved to the restored user.');
})().catch((error) => fail('unexpected SDK error', error));
"""


def main() -> int:
    if not sys.stdin.isatty():
        print("Run in an interactive Terminal; no credential was read.")
        return 2
    try:
        with open("/dev/tty", "rb") as tty:
            termios.tcgetattr(tty.fileno())
    except (OSError, termios.error):
        print("Terminal cannot hide input; no credential was read.")
        return 2

    try:
        user_id, email = restored_password_user()
    except Exception as exc:
        print(f"Backup user check failed: {type(exc).__name__}")
        return 1

    print("This changes one copied user's password in the disposable project only.")
    print("It does not prove the original password or the Okta sign-in settings.")
    if input(f"Type RESET {DESTINATION_REF} to continue: ").strip() != f"RESET {DESTINATION_REF}":
        print("Cancelled; no Auth change made.")
        return 2

    publishable = getpass.getpass("Disposable project's publishable key (hidden): ").strip()
    secret = getpass.getpass("Disposable project's secret key (hidden): ").strip()
    password = getpass.getpass("New temporary password for copied user (hidden): ")
    again = getpass.getpass("Repeat new temporary password (hidden): ")
    if password != again or len(password) < 12:
        print("Password mismatch or shorter than 12 characters; no Auth change made.")
        return 2
    if not (publishable.startswith("sb_publishable_") or publishable.startswith("eyJ")):
        print("Expected a publishable or legacy anon key; no Auth change made.")
        return 2
    if not (secret.startswith("sb_secret_") or secret.startswith("eyJ")):
        print("Expected a secret or legacy service-role key; no Auth change made.")
        return 2

    child_env = os.environ.copy()
    child_env.update({
        "T14A_REF": DESTINATION_REF,
        "T14A_USER_ID": user_id,
        "T14A_EMAIL": email,
        "T14A_PUBLISHABLE_KEY": publishable,
        "T14A_SECRET_KEY": secret,
        "T14A_NEW_PASSWORD": password,
    })
    result = subprocess.run(
        ["node", "-e", NODE_CHECK], env=child_env, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    for line in result.stdout.splitlines():
        if line.startswith(("Restored user", "Disposable password", "Issued session", "Auth verification")):
            print(line)
    if result.returncode:
        print("Auth verification did not finish; technical details withheld.")
    publishable = secret = password = again = None
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
