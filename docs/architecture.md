# Architecture

## Account and browser boundaries

GoodNightUESTC uses Node.js, Playwright and a persistent Chromium-family browser profile. School-specific requests live in `src/adapters/uestc.mjs`; configuration and account registry handling live in `src/config.mjs` and `src/accounts.mjs`.

The original account is `default` at the root data directory. Other accounts use `accounts/<id>`. Each has its own browser profile, configuration, identity binding, locks, schedule, submission journal and result logs. New accounts start with submissions and automatic reauthentication disabled. School identity hashes prevent a directory from silently switching students or registering the same identity twice.

## One check-in

1. Validate configuration and acquire the account's browser lock.
2. Start its persistent browser context and verify business authentication.
3. Read today's record. Require the Shanghai business date and a recognized status; skip records already handled or exempt.
4. Read the effective school schedule and enforce its check-in window and local cutoff.
5. Obtain browser-provided location or explicit fixed configuration, validate accuracy, and match a returned dormitory circle.
6. Re-read the record and schedule immediately before submitting.
7. Flush an exclusive daily submission claim, submit one check-in request, and reconcile using read-only record queries.
8. Confirm the matching date and `CHECKED_IN`, close the browser and release the lock.

No fallback situation-report submission exists. A dry run follows the read-only preparation path and does not claim or send a check-in POST. Other completed record states can be skipped without claiming that this client submitted them.

## Authentication

The manual login interface and automatic requests use the same account profile. Unified authentication and the registered application entry establish business authentication separately. Optional recovery is triggered only by explicit login expiry, not a network failure. Saved school credentials are scoped to that profile and school origin. Unknown forms, interactive challenges and identity mismatches stop recovery.

Validated school SESSION credentials receive a minimum local retention period without shortening an existing longer expiry. This affects browser storage only; it does not change server expiry or revocation. Trusted-browser and MFA policies remain school-controlled.

## Location

Browser mode invokes the school frontend's location provider with GCJ-02 requested. If a global API is unavailable, Acorn parses current same-origin entry and student chunks and resolves the imported location binding. Ambiguous or changed contracts fail closed rather than guessing aliases.

Fixed mode reads private configuration directly. Its accuracy and coordinates are explicit values rather than measurements. Both modes validate precision and the school's available circle geometry. Frontend logic does not establish the backend's complete validation rules.

## Scheduling and storage

The single-account daemon loads configuration at startup. The multi-account supervisor reloads account configuration each cycle and awaits each account sequentially, limiting concurrent browser use. One account's runtime or configuration error is recorded and processing continues with later accounts. A separate supervisor lock prevents duplicate multi-account daemons.

All business dates use `Asia/Shanghai`. State writes use a flushed temporary file and rename. The check-in claim is exclusively created and flushed before the POST; after an uncertain response or restart, later runs read the saved school record instead of repeating the POST. These client mechanisms cannot guarantee server retention or survival of every disk or power failure.

Credentials, coordinates, real records and deployment evidence belong in private data storage and local notes, not in published source or logs. Offline tests exercise the control flow using synthetic data and are not proof of live acceptance.
