# Task6 Security customer alert wording

Status: **Approved for the first monitor-only subset**

Last updated: **2026-09-29**

Approval recorded: **2026-09-29**

These alerts are for the first monitor-only release. They tell a customer what
the coding agent requested. They do not claim that TrackAI blocked the action
or that the action succeeded.

## Common display rules

| Item | Customer-facing rule |
|---|---|
| Status | Show **Monitoring alert**. Never show **Blocked** or **Prevented**. |
| Evidence | Say **requested** unless a separate result was observed. |
| Missing result | Say **TrackAI could not confirm whether the action ran or completed**. |
| Sensitive details | Do not show or upload the command, file path, URL, host, secret or command output. |
| Access | Use the existing tenant and role controls. |
| Customer action | Give short investigation steps; do not imply compromise. |

## Approved alerts

| Rule | Alert title | What happened | Why it matters | Recommended customer action |
|---|---|---|---|---|
| Destructive recursive deletion | **Large deletion requested** | A coding agent requested deletion of a major computer location, such as the filesystem root or a user home folder. | The request could remove source code, documents, settings or system files. | Check the related agent session. Confirm whether the request was expected. Check backups and the affected computer if it was not expected. |
| Download followed by immediate execution | **Downloaded content requested for immediate execution** | A coding agent requested downloading content and passing it directly to a command interpreter. | Unreviewed internet content could change the computer, install software or expose data. | Check the related agent session. Confirm that the source and installation method were approved. Review the computer if the request was unexpected. |
| Reverse shell request | **Remote command channel requested** | A coding agent requested a network connection that could provide remote command access. | If completed, another system could control commands or access data on the computer. | Treat an unexpected alert as high priority. Review the agent session and the computer's network and process activity. |

## Evidence wording

| Available evidence | Text shown to the customer |
|---|---|
| Request only | **TrackAI observed this request. TrackAI could not confirm whether it ran or completed.** |
| Request and successful result | **TrackAI observed this request and the host reported that the command completed successfully.** |
| Request and failed result | **TrackAI observed this request and the host reported that the command failed.** |
| Partial evidence | **TrackAI observed part of this request but did not receive enough information to confirm all details.** |
| No usable evidence | **This agent or host did not provide enough information to evaluate this activity.** |

## Wording that must not be used

| Do not say | Reason |
|---|---|
| “TrackAI blocked the attack.” | The first release does not block actions. |
| “The computer was compromised.” | A matching request does not prove compromise. |
| “The command succeeded.” | This requires a separate successful result event. |
| “No risk was found.” when evidence is missing | Missing evidence is unavailable, not a clean result. |
| Any raw command, path, URL, destination or output | These fields remain local and sensitive. |
