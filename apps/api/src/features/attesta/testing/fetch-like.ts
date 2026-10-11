// The fetch surface the A15.5 anchoring adapters depend on. The adapters
// take an injectable `FetchLike` so tests can hand them an in-process fake
// (FakeRekor, FakeTsa) instead of the network.

/** Minimal `fetch`: enough for the Rekor and TSA adapters, faked in tests. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
