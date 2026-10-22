# Is the cryptographic engine a moat? (Attesta, Audit, and sibling products)

*Note for the founder from the TrackAI-Orchestrator discussion of 2026-10-21. Applies to TrackAI (code), SushiCorp (media assets) and later products that share the same provenance engine.*

## Short answer
The engine itself (hash chain, signing with the customer's key, anchoring to Rekor and an RFC 3161 timestamp authority, offline verifier) is **not** a moat: a strong team can build it in weeks from open standards. The moat is what feeds it, who operates it, and whose evidence outsiders accept.

## Can a customer build it themselves?
Yes. What they underestimate is the next ten years: key rotation and revocation, keeping old records verifiable as algorithms age, transparency-log version changes (Rekor v2), timestamp-authority certificate expiry, and silent bugs where a chain "verifies" but proves nothing (the SushiCorp gotchas). In-house systems of this kind tend to rot when their builder leaves.

## Self-audit: is there a conflict of interest?
- **Integrity** (nothing changed after the fact): self-operation is fine. Public anchoring adds independent witnesses for time and order; an auditor can verify offline. SOC 2 and ISO auditors accept controls a company runs itself if they are designed and tested well. Independence is required of the auditor, not of the logging system.
- **Completeness and truthfulness** (everything recorded, recorded correctly, nothing omitted): self-operation is weak. Whoever controls capture and signing can choose what goes in or sign a false statement; offline verification cannot detect what was never recorded.
- **Adversarial settings** (M&A diligence, litigation, insurance claims, regulator disputes): evidence produced by the interested party is discounted, like unaudited books. A neutral third party that captured and signed at the time carries real weight, especially against model vendors attesting their own output.

## How many build it themselves?
No reliable survey found. Judgement: outside the largest technology companies (which built SLSA-style internal provenance), very few, likely low single-digit percent. Reasons to buy: someone else owns long-term verifiability and liability; scarce cryptographic expertise and silent failure modes; evidence formats auditors and acquirers already accept; coverage of sources the customer does not instrument; independence; speed.

## Where the moat is
1. **Capture:** cross-machine, cross-agent, cross-model, cross-surface attribution (Task2, Task13, Task9, and cloud sensors per `STRATEGY_CLOUD_AGENTS_2026-10-22.md`). Customers can sign data; they do not have this data.
2. **Neutrality:** the third-party position, which do-it-yourself cannot copy.
3. **Accepted evidence:** if our evidence pack and verifier become what acquirers, auditors and insurers expect, a network effect.
4. **Answers, not logs:** the customer and auditor questions (Task19), audit reports, compliance mappings.
5. **Operations over time:** key lifecycle, revocation, re-anchoring, long-term verifiability.

## Product moves
- **Witness co-signing (Attesta phase 2 candidate):** each statement carries the customer's signature (their key) plus a TrackAI witness counter-signature (a key TrackAI holds) attesting "captured independently at time T". It answers the self-audit objection directly and cannot be replicated in-house; the same idea as independent witnesses in Certificate Transparency.
- **Open the format and the verifier, possibly the engine core:** giving away the commodity part builds trust ("verify us without us") and pushes the format toward a standard; value stays in capture, neutrality and answers. Consistent with a shared `provenance-core` across TrackAI, SushiCorp and later products (agent-kit README, "Shared libraries: not yet").
