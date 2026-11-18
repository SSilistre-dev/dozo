# Security

## Reporting a vulnerability

Report it privately through GitHub:
[Report a vulnerability](https://github.com/SSilistre-dev/dozo/security/advisories/new).
Do not open a public issue for a vulnerability that is not fixed yet.

Please include:

- Steps to reproduce
- Impact (what an attacker could do)
- Whether the issue is already public

## Scope

This policy covers the code in this repository and the hosted pre-release that runs it.

Out of scope:

- Third-party AI models, their APIs and other external services
- Misconfiguration of a self-hosted install (exposed secrets, open databases, weak passwords)

Fixes land on `main`. There is no bug bounty program.

## Upstream

Dozo is an independent fork of [Rakazo](https://github.com/elie222/rakazo) (Apache-2.0) and is not
affiliated with or endorsed by it. The `SECURITY.md` at the repository root is upstream's file, kept
unmodified: its contact addresses are upstream's, not Dozo's. Its section on
[prompt injection and outbound data](https://github.com/SSilistre-dev/dozo/blob/main/SECURITY.md#prompt-injection-and-outbound-data)
describes this code as well.
