# Task6 Wave 4 safe delivery design

Status: **Implementation boundary recorded; evidence gates remain open**

Last updated: **2026-09-29**

## Customer view

| Question | Wave 4 answer |
|---|---|
| What leaves the device? | Fixed IDs and categories: rule, severity, route, certainty, result, time and software versions. |
| What stays on the device? | Commands, prompts, responses, paths, URLs, arguments, output and detected secret values. |
| Who decides the customer and machine? | TrackAI derives both from the authenticated Task4 machine credential. The client cannot choose them. |
| Can this stop work? | No. The only effect is `monitor`. Blocking and the Policy engine remain deferred. |

## Reuse of the Task4 delivery boundary

| Task4 control | Wave 4 use |
|---|---|
| Managed machine credential | Authenticate every finding upload and fail closed after revocation. |
| Installed repository binding | Capture repository ID, tenant route and credential key at queue time. |
| Durable local state | Retain safe finding metadata across offline periods and restart. |
| Bounded retry and partial acknowledgement | Retry temporary failures, accept successful rows and quarantine permanent row errors. |
| Server repository grant check | Reject a repository that is not actively granted to the authenticated machine. |

## Two related records

The approved `security-finding` contract is the final server record. Its
`tenantId` and `machineId` fields are filled from authenticated server context.
The client upload record intentionally omits those two claims.

| Record | Identity source | Purpose |
|---|---|---|
| Client upload | Task4-bound repository ID plus safe local IDs/categories | Carries the minimum safe data to TrackAI. |
| Final finding | Authenticated tenant/machine plus the authorized repository and validated upload | Becomes the canonical tenant-isolated record in the later server-storage wave. |

## Delivery sequence

1. OpenCode supplies a pre-action event; the raw command is evaluated only in
   memory on the device.
2. A match becomes a closed metadata record and is captured with its immutable
   Task4 repository/credential binding.
3. The local queue retries temporary failures and never logs the request body.
4. TrackAI authenticates the credential, checks the machine/repository grant,
   derives tenant and machine identity, validates every field and returns
   per-record acknowledgement.

## Fail-closed outcomes

| Situation | Outcome |
|---|---|
| Mode is `off`, missing, expired or revoked | No evaluation and no finding. |
| Credential is revoked | Upload is rejected; no fallback credential is used. |
| Repository grant is missing or belongs to another tenant | Finding is rejected. |
| Unknown or content-bearing field appears | Record is rejected before persistence. |
| Network or server is unavailable | Safe metadata remains queued for bounded retry. |

## Wave boundary

Wave 4 may add the client projection, queue, upload contract, authenticated
admission and delivery tests. Wave 5 owns durable server finding storage,
role-based reads, audit and UI. S6.7 blocking and a dynamic Policy engine remain
out of scope.
