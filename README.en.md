# GoodNightUESTC

A UESTC dormitory check-in tool based on [beichenO2/GoodNight](https://github.com/beichenO2/GoodNight), built with Node.js and Playwright, with Linux server support.

- Isolated account profiles, configuration and records, with individual Shanghai-time schedules.
- School schedule and dormitory-range checks, followed by saved-record verification.
- Browser location or explicitly configured GCJ-02 coordinates.
- Automatic reauthentication; initial login, CAPTCHA and MFA require the owner.
- Read-only reconciliation after uncertain submissions to avoid duplicate requests.

Requires Node.js 22+ and a browser runtime. An agent can follow the [deployment guide](docs/linux-server.md); detailed commands and troubleshooting belong in the documentation.

[Architecture](docs/architecture.md) · [Platforms and data](docs/portability.md) · [Recovery](docs/resilience.md) · [Contributing](CONTRIBUTING.md)

Keep account details, coordinates, browser data and operational records private. Fixed coordinates are configuration values, not measured real-time location. See [Security](SECURITY.md).

[中文说明](README.md) · [MIT License](LICENSE)
