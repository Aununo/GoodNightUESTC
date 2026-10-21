# Connection outages and local credential retention

This retained upstream incident path describes the failure mechanism and mitigation without reproducing private request traces, account timelines or live submission records.

If a client shortens a validated browser credential to a small local expiry, a prolonged network outage can prevent renewal and cause local credential loss. A later unauthenticated response alone cannot distinguish local deletion from server expiry or revocation.

After successful business-authentication verification, the current adapter preserves the school SESSION credential for at least seven days locally, retaining any longer existing expiry and its security attributes. Failed requests and rejected authentication do not extend retention. This does not change the school's server-side session lifetime.

Transport errors use sanitized codes rather than raw request traces. Optional login recovery is triggered only by explicit authentication expiry, not network failure; interactive challenges still require the owner.

Synthetic tests in `test/auth-retention.test.mjs` and `test/auth-recovery.test.mjs` exercise these rules. Real outage diagnostics, browser state and school outcomes belong in private storage.
