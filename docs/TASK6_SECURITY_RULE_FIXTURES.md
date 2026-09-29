# Task6 Security approved-rule fixture plan

Status: **Draft test cases; not executable**

Last updated: **2026-09-29**

These cases define expected behavior for the three approved monitor-only rules.
They are documentation fixtures only. The command tokens must never be executed
during documentation or schema tests.

## Expected outcomes

| Outcome | Meaning |
|---|---|
| `monitor_match` | The complete local evidence matches the rule. Show a monitoring alert. |
| `no_match` | Complete evidence is available and does not match. Do not create a finding. |
| `unavailable` | A required field or host capability is missing. Do not treat this as safe. |
| `error` | Parsing or evaluation failed. Do not create a successful protection claim. |

All `monitor_match` cases produce only the approved safe finding fields. The
command tokens, paths, URLs, destinations and outputs remain local.

## Destructive recursive deletion

| Case | Local input summary | Expected outcome | Required check |
|---|---|---|---|
| `delete-root-posix` | Parsed tokens equivalent to `rm`, recursive+force flags, and `/` | `monitor_match`; requested | Critical alert; raw target excluded from finding |
| `delete-home-expanded` | Recursive forced deletion where the parser confirms a home variable expands to the home folder | `monitor_match`; requested | Match only when expansion is confirmed |
| `delete-windows-root` | Parsed Windows recursive deletion targeting a drive root | `monitor_match`; requested | Windows dialect identified correctly |
| `delete-repository-build-output` | Recursive deletion of a repository build folder | `no_match` | Ordinary project cleanup remains negative |
| `delete-temporary-folder` | Recursive deletion inside an operating-system temporary folder | `no_match` | Temporary cleanup remains negative |
| `delete-quoted-example` | An `echo` or documentation command containing dangerous-looking text | `no_match` | Non-executed text remains negative |
| `delete-literal-home-variable` | A quoted home-variable token that the parser confirms will not expand | `no_match` | Literal text is not treated as the home folder |
| `delete-expansion-unknown` | Home-variable target present but expansion information missing | `unavailable` | Missing parser evidence never becomes `no_match` |

## Download followed by immediate execution

| Case | Local input summary | Expected outcome | Required check |
|---|---|---|---|
| `download-pipe-posix-shell` | HTTP(S) downloader output piped directly to a shell reading standard input | `monitor_match`; requested | High alert; URL and command excluded from finding |
| `download-pipe-script-interpreter` | Downloader output piped directly to Python, Ruby or Perl standard input | `monitor_match`; requested | Interpreter form is parsed, not text-searched |
| `download-save-only` | Download saved to a file and not executed | `no_match` | Download alone does not alert |
| `download-local-script-argument` | Downloader is in a pipeline, but the interpreter runs a named local script | `no_match` | Downloaded bytes are not the executed program |
| `download-shell-command-flag` | Downloader is piped to a shell that uses a separate command-string flag | `no_match` for this rule | The separate command may be reviewed by another future rule |
| `download-stdin-overridden` | Pipeline exists but the interpreter's input is redirected elsewhere | `no_match` | Only downloaded bytes executed as input should match |
| `download-quoted-example` | Documentation or printed text contains a download-and-run example | `no_match` | Non-executed text remains negative |
| `download-pipeline-unknown` | Host supplies command text but no reliable pipeline structure | `unavailable` | Do not guess from incomplete evidence |

## Reverse shell request

| Case | Local input summary | Expected outcome | Required check |
|---|---|---|---|
| `reverse-shell-device-redirect` | Interactive shell with a parsed TCP/UDP device redirect | `monitor_match`; requested | High alert; destination excluded from finding |
| `reverse-shell-netcat-exec` | Netcat-family command configured to execute a recognized shell | `monitor_match`; requested | Connect-back and bind forms are covered |
| `reverse-shell-socat` | Socat connection configured to execute a recognized shell | `monitor_match`; requested | Both network and shell sides must be present |
| `reverse-shell-generic-listener` | Generic network listener with no shell execution | `no_match` | Ordinary listeners remain negative |
| `reverse-shell-non-shell-exec` | Network tool executes a bounded non-shell utility | `no_match` | Only recognized command shells match this rule |
| `reverse-shell-documentation` | Example appears in documentation, a comment or printed text | `no_match` | Non-executed text remains negative |
| `reverse-shell-benign-socket-code` | Application code opens a normal socket without shell execution | `no_match` | Network activity alone does not alert |
| `reverse-shell-redirection-unknown` | Host omits parsed redirect or executable details | `unavailable` | Missing structure never becomes `no_match` |

## Shared result and safety cases

| Case | Expected outcome |
|---|---|
| Matching request with no result event | Alert says requested; outcome not confirmed |
| Matching request followed by failed result | Alert says requested and host-reported failure |
| Matching request followed by successful result | Alert says requested and host-reported success; never says TrackAI blocked it |
| Duplicate delivery of the same finding ID | One customer finding after replay/deduplication |
| Same local command under two tenants | Separate authorized findings; no cross-tenant access |
| Finding projection contains command/path/URL/output | Reject projection and record a content-free error |
| Monitoring is off | No rule finding is produced or uploaded |
| Unsupported host route | Report capability unavailable; do not claim protection |

## Review exit

Before S6.3 runtime work, reviewers must confirm:

1. each positive case should alert;
2. each negative case should stay quiet;
3. each incomplete case says unavailable;
4. customer wording is accurate and calm; and
5. no fixture authorizes raw security input upload or blocking.

