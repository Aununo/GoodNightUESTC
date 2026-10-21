# Contributing

Keep changes deterministic and specific to the supported UESTC check-in flow. This fork supports isolated accounts and Linux server execution; it does not submit fallback situation reports.

## Development

1. Use Node.js 22+ and install dependencies with `npm ci`.
2. Run `npm test` and `git diff --check`.
3. Use synthetic fixtures. CI must not contact the school, load real browser profiles or submit check-ins.
4. Update documentation when changing CLI options, private data paths, scheduling, authentication, location or verification behavior.

## Private data

Never commit credentials, cookies, browser profiles, school identity values, actual coordinates, student records, deployment account labels, personal report text, private logs, screenshots or server connection details. Keep operational notes local and ignored. Git ignore rules do not protect files already tracked or force-added.

Fixed location must remain an explicit configuration mode and must not be described as measured real-time location or silently used as a browser-location fallback. Each account needs its owner's authorization and separate authentication and range verification. Interactive authentication remains under the account owner's control.

## Integration and recovery

Preserve strict business-date, schedule, identity and geometry checks. Do not infer rejection from a missing response or repeat an uncertain submission. Success requires the matching saved school record. Changes to request behavior should include synthetic regression cases covering failures and recovery.

School pages and APIs may change. Fail closed on unknown response shapes or location contracts; do not repair them by guessing or using an LLM. Public evidence should describe code contracts and sanitized outcomes without live account data.

## Pull requests

Describe the concrete behavior change, relevant tests and remaining verification limits. Separate offline test results from live platform or school acceptance. Preserve upstream attribution and the MIT license.
