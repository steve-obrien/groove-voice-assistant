/**
 * Represents an expected application error that is safe to show to the user.
 */
export class AppError extends Error {
	/**
	 * Creates an application error.
	 *
	 * @param {string} message - User-safe error message.
	 * @param {{ code?: string, status?: number, details?: object }} [options] - Error metadata.
	 */
	constructor(message, options = {}) {
		super(message);
		this.name = "AppError";
		this.code = options.code ?? "APP_ERROR";
		this.status = options.status ?? 400;
		this.details = options.details;
	}
}

/**
 * Represents a failed Spotify Web API request.
 */
export class SpotifyApiError extends AppError {
	/**
	 * Creates a Spotify API error with response metadata.
	 *
	 * @param {string} message - User-safe Spotify error message.
	 * @param {{ status?: number, retryAfter?: number, details?: object }} [options] - Response metadata.
	 */
	constructor(message, options = {}) {
		super(message, {
			code: "SPOTIFY_API_ERROR",
			status: options.status ?? 502,
			details: options.details,
		});
		this.name = "SpotifyApiError";
		this.retryAfter = options.retryAfter;
	}
}
