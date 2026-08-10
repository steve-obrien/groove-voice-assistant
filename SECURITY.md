# Security policy

## Supported versions

Groove is an experimental local application. Security fixes are applied to the latest code on the default branch; older snapshots and forks are not supported.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue. Use the repository's **Security** tab and **Report a vulnerability** option to send the maintainers a private report. Include the affected version or commit, impact, reproduction steps, and any suggested mitigation.

Do not include real OpenAI keys, Spotify client secrets, OAuth tokens, or personal listening data. Revoke and replace any credential that may have been exposed.

## Deployment boundary

The included server is deliberately bound to `127.0.0.1` and designed for one trusted local user. Before adapting it for remote or multi-user deployment, add authenticated user sessions, encrypted per-user token storage, HTTPS, stronger CSRF protection, rate limits, durable OAuth state storage, and operational secret management.
