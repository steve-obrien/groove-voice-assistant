import { SpotifyApiError } from "./errors.js";

const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1";

/**
 * Pauses execution for a bounded retry delay.
 *
 * @param {number} milliseconds - Delay duration.
 * @returns {Promise<void>}
 */
function sleep(milliseconds) {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

/**
 * Extracts a user-safe error message from a Spotify response payload.
 *
 * @param {unknown} payload - Parsed Spotify error payload.
 * @returns {string} A user-safe message.
 */
function getSpotifyErrorMessage(payload) {
	if (typeof payload === "object" && payload !== null) {
		if (typeof payload.error === "object" && payload.error !== null) {
			return payload.error.message || "Spotify could not complete the request.";
		}

		if (typeof payload.error_description === "string") {
			return payload.error_description;
		}
	}

	return "Spotify could not complete the request.";
}

/**
 * Calls Spotify Web API endpoints with refresh and rate-limit handling.
 */
export class SpotifyClient {
	/**
	 * Creates a Spotify Web API client.
	 *
	 * @param {import("./spotify-auth.js").SpotifyAuth} auth - Spotify authorization manager.
	 * @param {{ fetchImpl?: typeof fetch, maxRetries?: number }} [dependencies] - Injectable dependencies.
	 */
	constructor(auth, dependencies = {}) {
		this.auth = auth;
		this.fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
		this.maxRetries = dependencies.maxRetries ?? 2;
	}

	/**
	 * Executes one authenticated Spotify Web API request.
	 *
	 * @param {string} endpoint - API path beginning with a slash.
	 * @param {{ method?: string, query?: Record<string, string | number | undefined>, body?: object }} [options] - Request options.
	 * @returns {Promise<any>} Parsed response data, or null for an empty response.
	 */
	async request(endpoint, options = {}) {
		let forceRefresh = false;
		let retriedAuthorization = false;

		for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
			const token = await this.auth.getAccessToken({ forceRefresh });
			forceRefresh = false;
			const url = new URL(`${SPOTIFY_API_BASE_URL}${endpoint}`);

			for (const [key, value] of Object.entries(options.query ?? {})) {
				if (value !== undefined && value !== "") {
					url.searchParams.set(key, String(value));
				}
			}

			const headers = {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
			};
			const requestOptions = {
				method: options.method ?? "GET",
				headers,
			};

			if (options.body !== undefined) {
				headers["Content-Type"] = "application/json";
				requestOptions.body = JSON.stringify(options.body);
			}

			const response = await this.fetchImpl(url, requestOptions);

			if (response.status === 401 && !retriedAuthorization) {
				retriedAuthorization = true;
				forceRefresh = true;
				continue;
			}

			if (response.status === 429 && attempt < this.maxRetries) {
				const retryAfter = Number.parseInt(
					response.headers.get("retry-after") ?? "1",
					10,
				);
				await sleep(Math.min(Math.max(retryAfter, 1), 5) * 1000);
				continue;
			}

			const text = await response.text();
			let payload = null;

			if (text) {
				try {
					payload = JSON.parse(text);
				} catch {
					payload = null;
				}
			}

			if (!response.ok) {
				throw new SpotifyApiError(getSpotifyErrorMessage(payload), {
					status: response.status,
					retryAfter: Number.parseInt(
						response.headers.get("retry-after") ?? "0",
						10,
					),
				});
			}

			return payload;
		}

		throw new SpotifyApiError("Spotify remained unavailable after retrying.", {
			status: 503,
		});
	}
}
