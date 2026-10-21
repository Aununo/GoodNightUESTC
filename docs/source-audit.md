# Integration contracts and evidence

This document describes code contracts and offline checks, not any particular student's deployment or check-in history. Real operational evidence belongs in private storage.

| Area | Source in this repository | Boundary |
| --- | --- | --- |
| School API and login | `src/adapters/uestc.mjs`, `src/auth-recovery.mjs` | Requests use the account's authenticated context; explicit expiry can invoke optional normal login recovery. Backend validation rules are not public. |
| Browser isolation | `src/browser.mjs`, `src/accounts.mjs` | Each account has its own persistent profile and school identity binding. |
| Browser location binding | `src/location.mjs`, `src/frontend-contract.mjs` | Parse current same-origin entry and student modules; reject missing or ambiguous bindings instead of guessing minified aliases. |
| Fixed location | `src/config.mjs`, `src/adapters/uestc.mjs` | Explicit private configuration only; never presented as measured location or inferred from another account. |
| Date, schedule and dormitory circle | `src/policy.mjs`, `src/runner.mjs` | Validate returned business data before submission; frontend checks cannot establish all server checks. |
| Submission journal | `src/store.mjs`, `src/runner.mjs` | Flush a daily claim before POST. Uncertain outcomes reconcile by reads, not repeated POSTs. |
| Success | `src/policy.mjs` | Require the matching business date and saved `CHECKED_IN` status. Other completed states may be skipped. |
| Multi-account scheduling | `src/multi-daemon.mjs` | Sequential tasks, separate state and one supervisor lock; reload configuration each cycle. |
| Services | `src/service.mjs` | Platform definition generation has offline coverage; installation and host behavior need separate verification. |
| Saved school login | `src/saved-school-login.mjs` | Profile-scoped, exact school realm, supported Linux Chromium v10 format only; no credential export. |

School JavaScript asset names, frontend exports, response fields and authentication policies can change. The runtime discovers location bindings from current source and validates known response shapes; a published asset snapshot is not a permanent API guarantee.

`npm test` uses synthetic records, locations, credentials and browser mocks. It does not contact school services, authenticate real accounts or submit check-ins. Public test results must not be described as proof of school-side acceptance, physical presence or universal platform support.

When documenting a future integration change, include reproducible code-level evidence and sanitized failure reasons. Keep names, account identifiers, coordinates, request headers, tokens and live records out of public issues and commits.
