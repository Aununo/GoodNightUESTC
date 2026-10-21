# Security policy

## Reporting

Do not publish credentials, personal records, browser profiles, private logs or exploitable details in an issue. Use the hosting platform's private reporting channel when available, or request a private contact route without including sensitive material.

## Local data boundary

GoodNightUESTC keeps per-account browser and runtime state so it can use authorized school sessions. Treat the data directory and private deployment notes as sensitive. Do not attach them to issues or pull requests. The repository does not need exported cookies, tokens or password databases.

Persistent browser storage and its encryption format are not a substitute for operating-system access controls. The optional Linux saved-login reader is limited to the account's own profile and exact school realm. Unsupported formats, ambiguous entries and interactive challenges stop automatic recovery.

Account identity bindings detect student changes and duplicate registration within the configured account registry. They do not provide isolation between unrelated operating-system users or protect a compromised server.

## Submission boundary

Only a matching saved `CHECKED_IN` record confirms check-in success. Uncertain requests are reconciled with reads rather than repeated POSTs. Journals cannot determine the server's final state while it is unavailable and do not guarantee recovery from every disk or power failure.

Fixed coordinates are explicit client-provided values, not proof of physical presence. School authentication and validation policies remain authoritative.

## Scope

Reports are welcome for the CLI, dependency use, service installation, file handling, account isolation and authentication boundaries. The project targets Node.js 22+ and provides macOS, Windows and Linux service definitions; synthetic CI does not establish live school or platform compatibility.
