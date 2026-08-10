import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

import { config } from "./config.js";
import { AppError } from "./errors.js";
import { createRealtimeCall } from "./realtime.js";
import { SpotifyAuth } from "./spotify-auth.js";
import { SpotifyClient } from "./spotify-client.js";
import { SpotifyService } from "./spotify-service.js";
import { createToolHandlers } from "./tools.js";

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIRECTORY = path.resolve(SOURCE_DIRECTORY, "../public");
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const LOOPBACK_HOSTNAMES = new Set([
	"127.0.0.1",
	"localhost",
	"[::1]",
	"::1",
]);

/**
 * Stores short-lived Spotify OAuth state values for CSRF protection.
 */
class OAuthStateStore {
	/**
	 * Creates an empty OAuth state store.
	 */
	constructor() {
		this.states = new Map();
	}

	/**
	 * Issues and stores a cryptographically random state value.
	 *
	 * @returns {string} New OAuth state.
	 */
	issue() {
		this.prune();
		const state = crypto.randomBytes(32).toString("base64url");
		this.states.set(state, Date.now() + OAUTH_STATE_TTL_MS);
		return state;
	}

	/**
	 * Consumes a state value exactly once when it is present and unexpired.
	 *
	 * @param {string | undefined} state - Returned OAuth state.
	 * @returns {boolean} True when the state is valid.
	 */
	consume(state) {
		if (!state) {
			return false;
		}

		const expiresAt = this.states.get(state);
		this.states.delete(state);
		return Boolean(expiresAt && expiresAt > Date.now());
	}

	/**
	 * Removes expired state entries to bound memory usage.
	 *
	 * @returns {void}
	 */
	prune() {
		const now = Date.now();

		for (const [state, expiresAt] of this.states.entries()) {
			if (expiresAt <= now) {
				this.states.delete(state);
			}
		}
	}
}

/**
 * Parses a Cookie request header into a key-value object.
 *
 * @param {string | undefined} cookieHeader - Raw Cookie header.
 * @returns {Record<string, string>} Parsed cookie values.
 */
function parseCookies(cookieHeader) {
	const cookies = {};

	for (const segment of cookieHeader?.split(";") ?? []) {
		const separatorIndex = segment.indexOf("=");

		if (separatorIndex < 0) {
			continue;
		}

		const name = segment.slice(0, separatorIndex).trim();
		const value = segment.slice(separatorIndex + 1).trim();

		if (name) {
			cookies[name] = decodeURIComponent(value);
		}
	}

	return cookies;
}

/**
 * Wraps an async Express handler so rejected promises reach error middleware.
 *
 * @param {Function} handler - Async Express request handler.
 * @returns {Function} Express-compatible request handler.
 */
function asyncRoute(handler) {
	/**
	 * Executes the wrapped route and forwards failures.
	 *
	 * @param {express.Request} request - Express request.
	 * @param {express.Response} response - Express response.
	 * @param {express.NextFunction} next - Express continuation callback.
	 * @returns {void}
	 */
	function wrappedRoute(request, response, next) {
		Promise.resolve(handler(request, response, next)).catch(next);
	}

	return wrappedRoute;
}

/**
 * Applies baseline security and cache headers to every response.
 *
 * @param {express.Request} request - Express request.
 * @param {express.Response} response - Express response.
 * @param {express.NextFunction} next - Express continuation callback.
 * @returns {void}
 */
function applySecurityHeaders(request, response, next) {
	response.set({
		"Cache-Control": request.path.startsWith("/api/")
			? "no-store"
			: "no-cache",
		"Content-Security-Policy": [
			"default-src 'self'",
			"connect-src 'self' https://api.openai.com",
			"img-src 'self' https: data:",
			"media-src 'self' blob:",
			"script-src 'self'",
			"style-src 'self'",
		].join("; "),
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
	});
	next();
}

/**
 * Reports whether a hostname is an explicit local loopback address.
 *
 * @param {string} hostname - URL hostname to inspect.
 * @returns {boolean} True for supported IPv4, IPv6, or localhost loopback names.
 */
function isLoopbackHostname(hostname) {
	return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Validates a request origin against the configured origin and safe loopback aliases.
 *
 * @param {string} requestOrigin - Origin supplied by the browser.
 * @param {string} expectedOrigin - Configured application origin.
 * @returns {boolean} True when the origin is allowed.
 */
export function isAllowedRequestOrigin(requestOrigin, expectedOrigin) {
	try {
		const requestUrl = new URL(requestOrigin);
		const expectedUrl = new URL(expectedOrigin);

		if (requestUrl.origin === expectedUrl.origin) {
			return true;
		}

		return (
			requestUrl.protocol === expectedUrl.protocol &&
			requestUrl.port === expectedUrl.port &&
			isLoopbackHostname(requestUrl.hostname) &&
			isLoopbackHostname(expectedUrl.hostname)
		);
	} catch {
		return false;
	}
}

/**
 * Creates middleware that rejects cross-origin browser requests to local mutations.
 *
 * @param {string} appBaseUrl - Configured public application origin.
 * @returns {Function} Express same-origin guard.
 */
function createSameOriginGuard(appBaseUrl) {
	const expectedOrigin = new URL(appBaseUrl).origin;

	/**
	 * Validates Origin and Fetch Metadata headers when a browser supplies them.
	 *
	 * @param {express.Request} request - Express request.
	 * @param {express.Response} response - Express response.
	 * @param {express.NextFunction} next - Express continuation callback.
	 * @returns {void}
	 */
	function requireSameOrigin(request, response, next) {
		const origin = request.get("origin");
		const fetchSite = request.get("sec-fetch-site");
		const originAllowed =
			!origin || isAllowedRequestOrigin(origin, expectedOrigin);
		const metadataAllowed = origin
			? originAllowed
			: !fetchSite || ["same-origin", "none"].includes(fetchSite);

		if (!originAllowed || !metadataAllowed) {
			next(
				new AppError("Cross-origin requests are not allowed.", {
					code: "CROSS_ORIGIN_REQUEST",
					status: 403,
				}),
			);
			return;
		}

		next();
	}

	return requireSameOrigin;
}

/**
 * Converts an unknown error into a user-safe API response.
 *
 * @param {unknown} error - Thrown error.
 * @param {express.Request} request - Express request.
 * @param {express.Response} response - Express response.
 * @param {express.NextFunction} next - Express continuation callback.
 * @returns {void}
 */
function handleError(error, request, response, next) {
	if (response.headersSent) {
		next(error);
		return;
	}

	const isExpected = error instanceof AppError;
	const status = isExpected ? error.status : 500;
	const message = isExpected
		? error.message
		: "The server could not complete that request.";

	if (!isExpected) {
		console.error(error);
	}

	response.status(status).json({
		error: {
			code: isExpected ? error.code : "INTERNAL_ERROR",
			message,
		},
	});
}

/**
 * Creates the configured Express application and its service graph.
 *
 * @param {{ appConfig?: object, fetchImpl?: typeof fetch, spotifyAuth?: SpotifyAuth, spotifyService?: SpotifyService }} [dependencies] - Optional test dependencies.
 * @returns {express.Express} Configured Express application.
 */
export function createApp(dependencies = {}) {
	const appConfig = dependencies.appConfig ?? config;
	const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
	const spotifyAuth =
		dependencies.spotifyAuth ?? new SpotifyAuth(appConfig, { fetchImpl });
	const spotifyClient = new SpotifyClient(spotifyAuth, { fetchImpl });
	const spotifyService =
		dependencies.spotifyService ?? new SpotifyService(spotifyClient);
	const toolHandlers = createToolHandlers(spotifyService);
	const oauthStateStore = new OAuthStateStore();
	const app = express();
	const secureCookies = appConfig.appBaseUrl.startsWith("https://");
	const requireSameOrigin = createSameOriginGuard(appConfig.appBaseUrl);

	app.disable("x-powered-by");
	app.use(applySecurityHeaders);

	/**
	 * Returns the safe configuration and connection status used by the UI.
	 *
	 * @param {express.Request} request - Express request.
	 * @param {express.Response} response - Express response.
	 * @returns {Promise<void>}
	 */
	async function getStatus(request, response) {
		response.json({
			openai_configured: Boolean(appConfig.openAiApiKey),
			spotify_configured: spotifyAuth.isConfigured(),
			spotify_connected: await spotifyAuth.isConnected(),
		});
	}

	/**
	 * Begins Spotify's server-side Authorization Code flow.
	 *
	 * @param {express.Request} request - Express request.
	 * @param {express.Response} response - Express response.
	 * @returns {void}
	 */
	function startSpotifyAuthorization(request, response) {
		const state = oauthStateStore.issue();
		response.cookie("groove_spotify_state", state, {
			httpOnly: true,
			maxAge: OAUTH_STATE_TTL_MS,
			path: "/auth/spotify",
			sameSite: "lax",
			secure: secureCookies,
		});
		response.redirect(spotifyAuth.getAuthorizationUrl(state));
	}

	/**
	 * Completes Spotify authorization and returns the user to the application.
	 *
	 * @param {express.Request} request - Express request.
	 * @param {express.Response} response - Express response.
	 * @returns {Promise<void>}
	 */
	async function completeSpotifyAuthorization(request, response) {
		const cookies = parseCookies(request.headers.cookie);
		const returnedState =
			typeof request.query.state === "string" ? request.query.state : undefined;
		const stateMatches =
			cookies.groove_spotify_state === returnedState &&
			oauthStateStore.consume(returnedState);

		response.clearCookie("groove_spotify_state", {
			path: "/auth/spotify",
		});

		if (!stateMatches) {
			response.redirect("/?spotify=error&message=Authorization%20state%20expired");
			return;
		}

		if (typeof request.query.error === "string") {
			response.redirect("/?spotify=error&message=Spotify%20access%20was%20not%20granted");
			return;
		}

		if (typeof request.query.code !== "string") {
			response.redirect("/?spotify=error&message=Spotify%20did%20not%20return%20a%20code");
			return;
		}

		try {
			await spotifyAuth.exchangeAuthorizationCode(request.query.code);
			response.redirect("/?spotify=connected");
		} catch (error) {
			const message =
				error instanceof AppError
					? error.message
					: "Spotify authorization failed.";
			response.redirect(`/?spotify=error&message=${encodeURIComponent(message)}`);
		}
	}

	/**
	 * Proxies a browser SDP offer into OpenAI's unified Realtime WebRTC API.
	 *
	 * @param {express.Request} request - Express request containing an SDP body.
	 * @param {express.Response} response - Express response.
	 * @returns {Promise<void>}
	 */
	async function startRealtimeSession(request, response) {
		if (!(await spotifyAuth.isConnected())) {
			throw new AppError("Connect Spotify before starting the voice assistant.", {
				code: "SPOTIFY_NOT_CONNECTED",
				status: 401,
			});
		}

		const answer = await createRealtimeCall(request.body, appConfig, fetchImpl);
		response.status(201).type("application/sdp").send(answer);
	}

	/**
	 * Executes an allow-listed Spotify tool requested by the Realtime assistant.
	 *
	 * @param {express.Request} request - Express request containing tool arguments.
	 * @param {express.Response} response - Express response.
	 * @returns {Promise<void>}
	 */
	async function executeSpotifyTool(request, response) {
		if (!request.is("application/json")) {
			throw new AppError("Assistant tool requests must use JSON.", {
				code: "JSON_REQUIRED",
				status: 415,
			});
		}

		const handler = toolHandlers[request.params.toolName];

		if (!handler) {
			throw new AppError("That assistant tool is not available.", {
				code: "UNKNOWN_TOOL",
				status: 404,
			});
		}

		const result = await handler(request.body ?? {});
		response.json({ result });
	}

	/**
	 * Returns a compact current-player snapshot for display.
	 *
	 * @param {express.Request} request - Express request.
	 * @param {express.Response} response - Express response.
	 * @returns {Promise<void>}
	 */
	async function getPlayer(request, response) {
		if (!(await spotifyAuth.isConnected())) {
			response.status(204).end();
			return;
		}

		response.json(await spotifyService.getPlaybackState());
	}

	app.get("/api/status", asyncRoute(getStatus));
	app.get("/auth/spotify", startSpotifyAuthorization);
	app.get(
		"/auth/spotify/callback",
		asyncRoute(completeSpotifyAuthorization),
	);
	app.post(
		"/api/realtime/session",
		requireSameOrigin,
		express.text({ type: ["application/sdp", "text/plain"], limit: "64kb" }),
		asyncRoute(startRealtimeSession),
	);
	app.use(express.json({ limit: "32kb" }));
	app.post(
		"/api/tools/:toolName",
		requireSameOrigin,
		asyncRoute(executeSpotifyTool),
	);
	app.get("/api/spotify/player", asyncRoute(getPlayer));
	app.use(express.static(PUBLIC_DIRECTORY));
	app.use(handleError);

	return app;
}

/**
 * Starts the local HTTP server when this module is the process entrypoint.
 *
 * @returns {import("node:http").Server} Running HTTP server.
 */
export function startServer() {
	const app = createApp();
	const server = app.listen(config.port, config.host);

	/**
	 * Logs the safe local URL after the listening socket is ready.
	 *
	 * @returns {void}
	 */
	function handleListening() {
		console.log(`Groove is ready at ${config.appBaseUrl}`);
	}

	server.on("listening", handleListening);
	return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	startServer();
}
