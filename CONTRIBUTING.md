# Contributing to Groove

Thanks for helping improve Groove. Keep changes focused, explain the user-facing reason for them, and preserve the app's local-first security boundary.

## Development setup

1. Install Node.js 22 or 24.
2. Install the locked dependencies:

	```bash
	npm ci
	```

3. Copy `.env.example` to `.env.local` only when manual testing needs live OpenAI or Spotify access. Never commit credentials, OAuth tokens, conversation transcripts, or Spotify response data.
4. Run the development server with `npm run dev`.

The automated tests use deterministic fakes and must not require live credentials or make network requests.

## Code standards

- Use tabs for indentation in JavaScript, HTML, CSS, and JSON. YAML uses two spaces because tabs are invalid YAML indentation.
- Add a production-quality JSDoc block to every function and method.
- Keep the standard OpenAI API key, Spotify client secret, and Spotify OAuth tokens on the server.
- Keep Spotify operations behind the explicit tool allow-list and validate model-supplied arguments at the service boundary.
- Add or update tests for behavior and external API contract changes.
- Update the README when setup, configuration, features, limitations, or security behavior changes.

## Before opening a pull request

Run the same checks as CI:

```bash
npm run ci
git diff --check
```

Describe what changed, why it changed, how it was verified, and any remaining limitations. Do not include secrets or private account data in screenshots, logs, fixtures, or issue reports.
