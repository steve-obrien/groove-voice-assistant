import crypto from "node:crypto";
import fs from "node:fs/promises";

import { AppError } from "./errors.js";

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/**
 * Parses a JSON response without exposing credential-bearing response bodies.
 *
 * @param {Response} response - Fetch response to parse.
 * @returns {Promise<object>} Parsed response payload.
 */
async function parseTokenResponse(response) {
	let payload;

	try {
		payload = await response.json();
	} catch {
		throw new AppError("Spotify returned an unreadable authorization response.", {
			code: "SPOTIFY_AUTH_INVALID_RESPONSE",
			status: 502,
		});
	}

	if (!response.ok) {
		throw new AppError(
			payload.error_description || "Spotify authorization failed.",
			{
				code: "SPOTIFY_AUTH_FAILED",
				status: 502,
			},
		);
	}

	return payload;
}

/**
 * Maintains Spotify OAuth tokens on the trusted server side.
 */
export class SpotifyAuth {
	/**
	 * Creates a Spotify authorization manager.
	 *
	 * @param {object} appConfig - Application configuration.
	 * @param {{ fetchImpl?: typeof fetch }} [dependencies] - Injectable dependencies for tests.
	 */
	constructor(appConfig, dependencies = {}) {
		this.config = appConfig;
		this.fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
		this.tokens = null;
		this.loadingTokens = this.loadTokens();
	}

	/**
	 * Reports whether Spotify application credentials are configured.
	 *
	 * @returns {boolean} True when both client credentials are present.
	 */
	isConfigured() {
		return Boolean(
			this.config.spotifyClientId && this.config.spotifyClientSecret,
		);
	}

	/**
	 * Reports whether a refreshable Spotify connection is available.
	 *
	 * @returns {Promise<boolean>} True when stored tokens are available.
	 */
	async isConnected() {
		await this.loadingTokens;
		return Boolean(this.tokens?.refresh_token || this.tokens?.access_token);
	}

	/**
	 * Builds Spotify's authorization URL using the minimum required scopes.
	 *
	 * @param {string} state - Cryptographically random OAuth state.
	 * @returns {string} Spotify authorization URL.
	 */
	getAuthorizationUrl(state) {
		this.assertConfigured();

		const url = new URL(SPOTIFY_AUTHORIZE_URL);
		url.search = new URLSearchParams({
			client_id: this.config.spotifyClientId,
			response_type: "code",
			redirect_uri: this.config.spotifyRedirectUri,
			scope: [
				"playlist-modify-private",
				"user-modify-playback-state",
				"user-read-playback-state",
			].join(" "),
			state,
		}).toString();

		return url.toString();
	}

	/**
	 * Exchanges an authorization code and persists the resulting tokens.
	 *
	 * @param {string} code - One-time Spotify authorization code.
	 * @returns {Promise<void>}
	 */
	async exchangeAuthorizationCode(code) {
		this.assertConfigured();

		const payload = await this.requestToken({
			code,
			grant_type: "authorization_code",
			redirect_uri: this.config.spotifyRedirectUri,
		});

		await this.saveTokens(payload);
	}

	/**
	 * Returns a valid access token, refreshing it before expiry when needed.
	 *
	 * @param {{ forceRefresh?: boolean }} [options] - Refresh controls.
	 * @returns {Promise<string>} A current Spotify access token.
	 */
	async getAccessToken(options = {}) {
		await this.loadingTokens;

		if (!this.tokens) {
			throw new AppError("Connect your Spotify account first.", {
				code: "SPOTIFY_NOT_CONNECTED",
				status: 401,
			});
		}

		const shouldRefresh =
			options.forceRefresh ||
			!this.tokens.access_token ||
			Date.now() >= this.tokens.expires_at - TOKEN_EXPIRY_SKEW_MS;

		if (shouldRefresh) {
			await this.refreshAccessToken();
		}

		return this.tokens.access_token;
	}

	/**
	 * Refreshes the current Spotify access token and preserves refresh rotation.
	 *
	 * @returns {Promise<void>}
	 */
	async refreshAccessToken() {
		if (!this.tokens?.refresh_token) {
			throw new AppError("Reconnect Spotify to renew authorization.", {
				code: "SPOTIFY_REAUTH_REQUIRED",
				status: 401,
			});
		}

		const payload = await this.requestToken({
			grant_type: "refresh_token",
			refresh_token: this.tokens.refresh_token,
		});

		await this.saveTokens(payload);
	}

	/**
	 * Loads locally persisted Spotify tokens when the application starts.
	 *
	 * @returns {Promise<void>}
	 */
	async loadTokens() {
		try {
			const contents = await fs.readFile(this.config.spotifyTokenPath, "utf8");
			this.tokens = JSON.parse(contents);
		} catch (error) {
			if (error.code === "ENOENT") {
				this.tokens = null;
				return;
			}

			throw new AppError("The local Spotify token file could not be read.", {
				code: "SPOTIFY_TOKEN_STORE_INVALID",
				status: 500,
			});
		}
	}

	/**
	 * Persists tokens atomically with owner-only filesystem permissions.
	 *
	 * @param {object} payload - Spotify token endpoint response.
	 * @returns {Promise<void>}
	 */
	async saveTokens(payload) {
		const currentRefreshToken = this.tokens?.refresh_token;
		const normalizedTokens = {
			access_token: payload.access_token,
			expires_at: Date.now() + Number(payload.expires_in ?? 3600) * 1000,
			refresh_token: payload.refresh_token ?? currentRefreshToken,
			scope: payload.scope ?? this.tokens?.scope ?? "",
			token_type: payload.token_type ?? "Bearer",
		};

		if (!normalizedTokens.access_token) {
			throw new AppError("Spotify did not return an access token.", {
				code: "SPOTIFY_AUTH_INVALID_RESPONSE",
				status: 502,
			});
		}

		const temporaryPath = `${this.config.spotifyTokenPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
		await fs.writeFile(
			temporaryPath,
			`${JSON.stringify(normalizedTokens, null, "\t")}\n`,
			{ mode: 0o600 },
		);
		await fs.rename(temporaryPath, this.config.spotifyTokenPath);
		await fs.chmod(this.config.spotifyTokenPath, 0o600);
		this.tokens = normalizedTokens;
	}

	/**
	 * Calls Spotify's token endpoint with confidential client authentication.
	 *
	 * @param {Record<string, string>} form - OAuth token request fields.
	 * @returns {Promise<object>} Spotify token payload.
	 */
	async requestToken(form) {
		const credentials = Buffer.from(
			`${this.config.spotifyClientId}:${this.config.spotifyClientSecret}`,
		).toString("base64");
		const response = await this.fetchImpl(SPOTIFY_TOKEN_URL, {
			method: "POST",
			headers: {
				Authorization: `Basic ${credentials}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(form),
		});

		return parseTokenResponse(response);
	}

	/**
	 * Rejects Spotify operations until server-side app credentials exist.
	 *
	 * @returns {void}
	 */
	assertConfigured() {
		if (!this.isConfigured()) {
			throw new AppError(
				"Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env.local first.",
				{
					code: "SPOTIFY_NOT_CONFIGURED",
					status: 503,
				},
			);
		}
	}
}
