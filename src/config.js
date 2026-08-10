import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SOURCE_DIRECTORY, "..");

dotenv.config({ path: path.join(PROJECT_ROOT, ".env.local"), quiet: true });
dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });

/**
 * Parses a TCP port from an environment value and rejects unsafe values.
 *
 * @param {string | undefined} value - Environment value to parse.
 * @returns {number} A validated TCP port.
 */
function parsePort(value) {
	const port = Number.parseInt(value ?? "3003", 10);

	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("PORT must be an integer between 1 and 65535.");
	}

	return port;
}

/**
 * Removes a trailing slash so URL paths can be appended consistently.
 *
 * @param {string} value - Base URL to normalize.
 * @returns {string} The normalized base URL.
 */
function normalizeBaseUrl(value) {
	return value.replace(/\/$/, "");
}

/**
 * Builds the immutable application configuration from environment variables.
 *
 * @param {NodeJS.ProcessEnv} [environment=process.env] - Environment source.
 * @returns {Readonly<object>} Validated application configuration.
 */
export function createConfig(environment = process.env) {
	const port = parsePort(environment.PORT);
	const appBaseUrl = normalizeBaseUrl(
		environment.APP_BASE_URL ?? `http://127.0.0.1:${port}`,
	);

	return Object.freeze({
		appBaseUrl,
		host: "127.0.0.1",
		openAiApiKey: environment.OPENAI_API_KEY?.trim() ?? "",
		openAiModel: environment.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2.1",
		openAiVoice: environment.OPENAI_REALTIME_VOICE?.trim() || "marin",
		port,
		projectRoot: PROJECT_ROOT,
		spotifyClientId: environment.SPOTIFY_CLIENT_ID?.trim() ?? "",
		spotifyClientSecret: environment.SPOTIFY_CLIENT_SECRET?.trim() ?? "",
		spotifyRedirectUri:
			environment.SPOTIFY_REDIRECT_URI?.trim() ||
			`${appBaseUrl}/auth/spotify/callback`,
		spotifyTokenPath:
			environment.SPOTIFY_TOKEN_PATH?.trim() ||
			path.join(PROJECT_ROOT, ".spotify-tokens.json"),
	});
}

export const config = createConfig();
