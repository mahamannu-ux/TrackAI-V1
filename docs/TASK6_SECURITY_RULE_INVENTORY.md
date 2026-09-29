# Task6 Security pinned rule inventory

Status: **Initial three-rule subset approved; remaining dispositions under review**

Last updated: **2026-09-29**

Source: `perplexityai/numbat` at
`f0778c09dc48281aa93a3887d05096c0a1f3f9f7`, Apache-2.0. The authoritative
inputs are the 51 enabled YAML files under `rules/**/*.yaml` at that commit.

This is an inventory and review artifact only. Three rules were approved on
2026-09-29 for the first monitor-only subset. Approval does not mean they are
implemented, tested, uploaded or allowed to block. Fixtures, technical review
and license handling remain required before runtime work.

Plain-language approval brief:
[`TASK6_SECURITY_REMAINING_RULE_REVIEW.md`](TASK6_SECURITY_REMAINING_RULE_REVIEW.md).

## Disposition vocabulary

| Disposition | Meaning |
|---|---|
| **Approved first subset** | Approved for the smallest initial monitor-only subset; implementation still gated. |
| **Defer: parser** | Requires more shell/dialect parsing and false-positive fixtures. |
| **Defer: path** | Requires normalized path, expansion and cross-OS fidelity work. |
| **Defer: route** | AC-CLI-03 does not yet prove the required event/capability reliably. |
| **Defer: sequence** | Requires bounded ordered state, expiry and isolation design. |
| **Defer: product conflict** | Normal development or GitAI behavior is a required negative control. |
| **Exclude from v0.1** | Numbat-specific or policy/enforcement semantics do not belong in the first TrackAI monitor release. |

`requested` below means the OpenCode before-hook can support a monitor finding
about requested behavior when the named structured fields are available. It
does not prove execution or prevention. `Partial` and `unavailable` remain
first-class outcomes; missing fields never become `no_match`.

## Per-rule review matrix

### Ordered chains

| Upstream rule | Required transient evidence | AC-CLI-03 fidelity and main risk | Proposed disposition |
|---|---|---|---|
| `chain.guardrails_off_then_egress` v1.4 | Permission-mode evidence, content preview or tags, then outbound command/tool call | Host policy state and content preview are not in the initial safe contract | **Defer: sequence**; content/policy dependency |
| `chain.permission_denied_then_runtime_bypass` v1.3 | Correlated denial followed by agent-runtime command flags | Denial and later shell request may be observable, but cross-event identity/expiry is undefined | **Defer: sequence** |
| `chain.privilege_discovery_then_elevation` v1.3 | Reconnaissance command followed by elevation-capable command | Requested commands only; common administrator workflows need negatives | **Defer: sequence** |
| `chain.secret_manager_read_then_egress` v1.5 | Secret-manager request followed by data-bearing egress | Does not prove returned secret content was used; tool coverage is incomplete | **Defer: sequence** |
| `chain.secret_read_then_egress` v1.6 | Sensitive file/environment read followed by outbound command/tool call | Path expansion, tool coverage and causal wording are unresolved | **Defer: sequence** |
| `chain.workload_identity_then_lateral_execution` v1.6 | Workload-token read followed by remote workload execution | Requested actions only; session isolation and cloud context are unresolved | **Defer: sequence** |

### Execution

| Upstream rule | Required transient evidence | AC-CLI-03 fidelity and main risk | Proposed disposition |
|---|---|---|---|
| `exec.agent_runtime_bypass_flags` v1.3 | Structured command executable and permission-bypass flags | Requested command is observable; legitimate sandbox/debug invocations need explicit negatives | **Defer: product conflict** |
| `exec.destructive_recursive_delete` v1.5 | Structured Bash/PowerShell/cmd command, targets and expansions | High-signal requested action; unresolved variables, dry runs and repo cleanup must stay negative | **Approved first subset**; monitor only |
| `exec.download_pipe_shell` v1.4 | Structured pipeline, downloader, URL class and interpreter stdin semantics | High-signal requested action; downloads without execution and local scripts must stay negative | **Approved first subset**; monitor only |
| `exec.encoded_payload_shell` v1.4 | Decoder/interpreter pipeline and redirection semantics | Observable request, but shell dialect and stdin variants need broader fixtures | **Defer: parser** |
| `exec.reverse_shell` v1.3 | Executable, arguments, redirections and network-shell pattern | High-signal requested action; documentation strings and benign socket examples must stay negative | **Approved first subset**; monitor only |
| `exec.reverse_tunnel` v1.3 | Structured SSH/tunneling command and reverse-listener arguments | Requested command observable; legitimate developer tunnels are common | **Defer: parser**; high false-positive review |

### Exfiltration

| Upstream rule | Required transient evidence | AC-CLI-03 fidelity and main risk | Proposed disposition |
|---|---|---|---|
| `exfil.curl_post_file` v1.4 | Structured curl command, upload flags, local source and remote URL class | Requested upload is observable but sensitivity and destination trust are not established | **Defer: route** |
| `exfil.dns_tunnel_exec` v1.4 | Shell substitution/output flow into DNS command | Complex dialect/data-flow parsing; benign diagnostics are plausible | **Defer: parser** |
| `exfil.env_capture_to_network` v1.3 | Environment expansion captured into outbound command | Requires sensitive transient values and precise data-flow without persistence | **Defer: route** |
| `exfil.secret_read_and_egress_oneliner` v1.3 | Secret-manager read and outbound operation in one structured command | Requested flow only; provider syntax and causal claims need fixtures | **Defer: parser** |

### Impact

| Upstream rule | Required transient evidence | AC-CLI-03 fidelity and main risk | Proposed disposition |
|---|---|---|---|
| `impact.cryptomining_launch` v1.4 | Executable/package/image identity and mining arguments | Requested command observable; security research and fixture commands need negatives | **Defer: parser** |
| `impact.disk_wipe` v1.4 | Destructive storage command, target device and flags | High impact, but device/path semantics differ by OS and recovery tools | **Defer: parser** |
| `impact.fork_bomb` v1.3 | Parsed shell/function or process-spawn payload | High signal but dialect-specific; quoted examples must stay negative | **Defer: parser** |
| `impact.mass_process_termination` v1.4 | Process-control executable, target scope and flags | Requested command observable; service recovery/admin operations need negatives | **Defer: parser** |

### Integrity and lateral movement

| Upstream rule | Required transient evidence | AC-CLI-03 fidelity and main risk | Proposed disposition |
|---|---|---|---|
| `integrity.git_hooks_bypass` v1.2 | Git command and hook-bypass flags | `--no-verify` is a normal developer action and not itself malicious | **Defer: product conflict** |
| `integrity.history_tamper` v1.2 | Shell-history command or environment mutation | Requested command observable; privacy tools and shell maintenance need negatives | **Defer: parser** |
| `lateral.workload_exec` v1.5 | kubectl/cloud/container remote-exec target and command | Requested action observable; normal debugging is common and tenant context is absent | **Defer: route** |

### Persistence

| Upstream rule | Required transient evidence | AC-CLI-03 fidelity and main risk | Proposed disposition |
|---|---|---|---|
| `persistence.git_hook_write` v1.4 | File write path or command target under Git hooks | GitAI legitimately installs/manages hooks; linked worktrees and custom hook paths matter | **Defer: product conflict** |
| `persistence.privileged_account_change` v1.3 | Account-management executable, target and privilege flags | Requested action observable; administrative automation needs identity/context | **Defer: parser** |
| `persistence.scheduler_install` v1.7 | Scheduler/service command or unit/task file path | Mixed command/path evidence and extensive OS-specific legitimate automation | **Defer: path** |
| `persistence.shell_profile_write` v1.5 | File write or redirection to shell startup path | Path expansion and ordinary developer environment setup cause high false positives | **Defer: path** |
| `persistence.ssh_authorized_keys_command` v1.6 | Structured command/redirection targeting `authorized_keys` | Requested mutation may be visible; provisioning and rotation are required negatives | **Defer: path** |
| `persistence.ssh_authorized_keys` v1.2 | Normalized file-write path | OpenCode edit coverage may observe the path, but append/redirection and OS homes vary | **Defer: path** |

### Privilege

| Upstream rule | Required transient evidence | AC-CLI-03 fidelity and main risk | Proposed disposition |
|---|---|---|---|
| `privilege.access_control_mutation` v1.3 | chmod/chown/ACL command, target and permission scope | Requested action observable; routine repository permission repair is common | **Defer: parser** |
| `privilege.container_host_escape` v1.3 | Container run flags, mounts, capabilities and namespaces | Requested action observable; local development containers need substantial negatives | **Defer: parser** |
| `privilege.container_runtime_socket_access` v1.3 | Socket path access or container mount arguments | Path/mount evidence varies; normal Docker tooling routinely accesses the socket | **Defer: product conflict** |
| `privilege.elevated_shell` v1.3 | Elevation utility plus interactive shell semantics | Requested action observable; legitimate admin/debug work is common | **Defer: parser** |
| `privilege.host_namespace_entry` v1.2 | Namespace-entry command, target PID and flags | Linux-specific; unsupported OS routes must report unavailable | **Defer: route** |
| `privilege.sudoers_tamper` v1.3 | File mutation path or command targeting sudoers policy | Path and command coverage vary; approved configuration management needs negatives | **Defer: path** |

### Reconnaissance

| Upstream rule | Required transient evidence | AC-CLI-03 fidelity and main risk | Proposed disposition |
|---|---|---|---|
| `recon.cloud_metadata` v1.4 | URL/destination and HTTP command/tool evidence | Requested access observable only for covered Bash/tool calls; cloud context is unknown | **Defer: route** |
| `recon.network_sweep` v1.4 | Scanner executable and multi-host/range arguments | Requested command observable; authorized inventory and test networks need negatives | **Defer: parser** |
| `recon.privilege_escalation` v1.3 | Enumeration executable and flags | Common diagnostic commands create high false-positive risk | **Defer: parser** |

### Secrets

| Upstream rule | Required transient evidence | AC-CLI-03 fidelity and main risk | Proposed disposition |
|---|---|---|---|
| `secrets.agent_read_env` v1.3 | File read or command path for `.env` variants | OpenCode may observe some reads, but ordinary application development reads `.env` | **Defer: product conflict** |
| `secrets.browser_session_store_read` v1.4 | Normalized browser profile/session-store path | Sensitive high-risk path; cross-browser, profile and OS normalization unresolved | **Defer: path** |
| `secrets.cloud_credential_read` v1.4 | Credential-store path or structured read/copy command | Sensitive path; legitimate CLI troubleshooting and migration need negatives | **Defer: path** |
| `secrets.cloud_secret_manager_read` v1.2 | Provider CLI/tool identity and secret-read operation | Requested access observable; authorization and returned-content use are unknown | **Defer: route** |
| `secrets.developer_credential_read` v1.4 | Developer credential-store path or read/copy command | Broad path set and routine tooling access create high false-positive risk | **Defer: path** |
| `secrets.process_environment_read` v1.3 | `/proc/*/environ` path or environment-dump command | Requested access observable on Linux; shell diagnostics and OS support vary | **Defer: route** |
| `secrets.read_private_key` v1.6 | Private-key/credential path or structured read/copy command | High sensitivity; home expansion, custom names and backup workflows need fixtures | **Defer: path** |
| `secrets.workload_identity_token_read` v1.3 | Workload token path or provider environment variable expansion | Cloud/container-only fidelity and variable expansion remain unresolved | **Defer: route** |

### Source control and tampering

| Upstream rule | Required transient evidence | AC-CLI-03 fidelity and main risk | Proposed disposition |
|---|---|---|---|
| `source.git_config_exec` v1.4 | Git config command, scope, key and executable value | GitAI and developer tooling legitimately manage helpers, filters and hooks | **Defer: product conflict** |
| `source.git_remote_tamper` v1.4 | Git remote/config command, remote identity and URL class | Repository onboarding and fork workflows routinely change remotes | **Defer: product conflict** |
| `tamper.agent_config_write` v1.8 | Host-agent config path or structured mutation command | Host-specific config paths and legitimate setup/update operations are unresolved | **Defer: path** |
| `tamper.detector_state_write` v1.4 | Numbat state-directory path or mutation command | The pinned path is Numbat-specific and is not a TrackAI protection boundary | **Exclude from v0.1**; redesign if TrackAI gains equivalent state |
| `tamper.guardrails_off` v1.1 | Host permission-mode tags or runtime flags | Initial TrackAI scope is monitor-only and does not own host approval policy | **Exclude from v0.1**; policy semantics deferred |

## Count and decision summary

| Proposed disposition | Count |
|---|---:|
| Approved first subset | 3 |
| Defer: sequence | 6 |
| Defer: parser | 15 |
| Defer: path | 10 |
| Defer: route | 8 |
| Defer: product conflict | 7 |
| Exclude from v0.1 | 2 |
| **Total** | **51** |

The counts are review bookkeeping, not an implementation commitment. E6-2
remains yellow until the remaining dispositions are reviewed, the three
approved rules have positive/negative/ambiguous fixtures, and Apache-2.0 notice
and modification handling are agreed.
