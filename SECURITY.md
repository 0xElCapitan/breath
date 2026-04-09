# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in BREATH, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email the maintainers directly or use GitHub's private vulnerability reporting feature.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix release**: Depends on severity (critical: ASAP, high: within 2 weeks)

## Scope

This policy covers the BREATH construct source code and its integration with:
- PurpleAir API v1
- EPA AirNow API

### Out of scope

- The PurpleAir and EPA AirNow APIs themselves
- Upstream Echelon framework vulnerabilities
- Third-party tools used in development

## Security Design

BREATH follows these security principles:

- **Zero production dependencies** — no supply chain attack surface
- **No secrets in code** — API keys via environment variables only
- **Immutable theatre state** — all state transitions produce new objects
- **Input validation** — oracle boundary guards on API responses
- **No eval/Function** — no dynamic code execution
