import { AppError, SpotifyApiError } from "./errors.js";

const MAX_TRACK_SEARCHES = 12;

/**
 * Validates and normalizes a required text argument.
 *
 * @param {unknown} value - Value to validate.
 * @param {string} fieldName - Human-readable field name.
 * @param {number} maximumLength - Maximum accepted length.
 * @returns {string} A trimmed string.
 */
function normalizeRequiredText(value, fieldName, maximumLength) {
	if (typeof value !== "string" || !value.trim()) {
		throw new AppError(`${fieldName} is required.`, {
			code: "INVALID_TOOL_ARGUMENTS",
			status: 400,
		});
	}

	return value.trim().slice(0, maximumLength);
}

/**
 * Validates and normalizes track search phrases supplied by the assistant.
 *
 * @param {unknown} value - Track search list to validate.
 * @returns {string[]} Normalized, de-duplicated search phrases.
 */
function normalizeTrackSearches(value) {
	if (!Array.isArray(value) || value.length === 0) {
		throw new AppError("At least one song search is required.", {
			code: "INVALID_TOOL_ARGUMENTS",
			status: 400,
		});
	}

	const searches = value
		.filter((item) => typeof item === "string" && item.trim())
		.map((item) => item.trim().slice(0, 160));
	const uniqueSearches = [...new Set(searches)].slice(0, MAX_TRACK_SEARCHES);

	if (uniqueSearches.length === 0) {
		throw new AppError("At least one valid song search is required.", {
			code: "INVALID_TOOL_ARGUMENTS",
			status: 400,
		});
	}

	return uniqueSearches;
}

/**
 * Selects an explicit playlist ID or falls back to the most recently created playlist.
 *
 * @param {unknown} value - Optional playlist ID supplied by the assistant.
 * @param {string | null} fallback - Most recently created playlist ID.
 * @returns {string} Playlist ID to mutate.
 */
function resolvePlaylistId(value, fallback) {
	const playlistId =
		typeof value === "string" && value.trim() ? value.trim() : fallback;

	if (!playlistId) {
		throw new AppError(
			"Create a playlist first, or provide the Spotify playlist ID.",
			{
				code: "PLAYLIST_ID_REQUIRED",
				status: 400,
			},
		);
	}

	return playlistId;
}

/**
 * Determines whether playlist creation succeeded but playback needs user action.
 *
 * @param {unknown} error - Playback error to classify.
 * @returns {boolean} True when playlist creation can still be reported as successful.
 */
function isRecoverablePlaybackError(error) {
	return (
		(error instanceof AppError && error.code === "NO_SPOTIFY_DEVICE") ||
		(error instanceof SpotifyApiError && [403, 404].includes(error.status))
	);
}

/**
 * Implements the Spotify capabilities exposed to the voice assistant.
 */
export class SpotifyService {
	/**
	 * Creates the Spotify domain service.
	 *
	 * @param {import("./spotify-client.js").SpotifyClient} client - Authenticated Spotify client.
	 */
	constructor(client) {
		this.client = client;
		this.lastCreatedPlaylistId = null;
	}

	/**
	 * Creates a private playlist, adds resolved tracks, and starts playback.
	 *
	 * @param {{ name: unknown, description?: unknown, track_searches: unknown, device_name?: unknown }} input - Tool arguments.
	 * @returns {Promise<object>} Playlist and playback outcome.
	 */
	async createPlaylistAndPlay(input) {
		const name = normalizeRequiredText(input.name, "Playlist name", 100);
		const description =
			typeof input.description === "string"
				? input.description.trim().slice(0, 300)
				: "Created by the Groove voice assistant.";
		const trackSearches = normalizeTrackSearches(input.track_searches);
		const resolved = await this.resolveTracks(trackSearches);
		const playlist = await this.client.request("/me/playlists", {
			method: "POST",
			body: {
				description,
				name,
				public: false,
			},
		});

		await this.client.request(`/playlists/${encodeURIComponent(playlist.id)}/items`, {
			method: "POST",
			body: {
				uris: resolved.tracks.map((track) => track.uri),
			},
		});

		this.lastCreatedPlaylistId = playlist.id;

		let playbackStarted = false;
		let playbackMessage = "Playback started.";

		try {
			await this.playContext(
				playlist.uri,
				typeof input.device_name === "string" ? input.device_name : undefined,
			);
			playbackStarted = true;
		} catch (error) {
			if (!isRecoverablePlaybackError(error)) {
				throw error;
			}

			playbackMessage =
				"The playlist was created, but Spotify needs an available Premium playback device. Open Spotify on a device, then ask me to play it.";
		}

		return {
			missed_searches: resolved.missedSearches,
			playback_message: playbackMessage,
			playback_started: playbackStarted,
			playlist_id: playlist.id,
			playlist_url: playlist.external_urls?.spotify,
			status: "playlist_created",
			track_count: resolved.tracks.length,
		};
	}

	/**
	 * Resolves and appends songs to a specified or recently created playlist.
	 *
	 * @param {{ playlist_id?: unknown, track_searches: unknown }} input - Tool arguments.
	 * @returns {Promise<object>} Playlist modification outcome.
	 */
	async addSongsToPlaylist(input) {
		const playlistId = resolvePlaylistId(
			input.playlist_id,
			this.lastCreatedPlaylistId,
		);

		const resolved = await this.resolveTracks(
			normalizeTrackSearches(input.track_searches),
		);
		await this.client.request(`/playlists/${encodeURIComponent(playlistId)}/items`, {
			method: "POST",
			body: {
				uris: resolved.tracks.map((track) => track.uri),
			},
		});

		return {
			added_count: resolved.tracks.length,
			missed_searches: resolved.missedSearches,
			playlist_id: playlistId,
			status: "songs_added",
		};
	}

	/**
	 * Resolves and removes songs from a specified or recently created playlist.
	 *
	 * @param {{ playlist_id?: unknown, track_searches: unknown }} input - Tool arguments.
	 * @returns {Promise<object>} Playlist modification outcome.
	 */
	async removeSongsFromPlaylist(input) {
		const playlistId = resolvePlaylistId(
			input.playlist_id,
			this.lastCreatedPlaylistId,
		);
		const resolved = await this.resolveTracks(
			normalizeTrackSearches(input.track_searches),
		);

		await this.client.request(`/playlists/${encodeURIComponent(playlistId)}/items`, {
			method: "DELETE",
			body: {
				items: resolved.tracks.map((track) => ({ uri: track.uri })),
			},
		});

		return {
			missed_searches: resolved.missedSearches,
			playlist_id: playlistId,
			removed_count: resolved.tracks.length,
			status: "songs_removed",
		};
	}

	/**
	 * Starts or resumes Spotify playback, optionally with a searched track.
	 *
	 * @param {{ query?: unknown, device_name?: unknown }} [input] - Playback arguments.
	 * @returns {Promise<object>} Playback outcome.
	 */
	async playMusic(input = {}) {
		const device = await this.getPreferredDevice(
			typeof input.device_name === "string" ? input.device_name : undefined,
		);
		let body;

		if (typeof input.query === "string" && input.query.trim()) {
			const resolved = await this.resolveTracks([input.query.trim()]);
			body = { uris: [resolved.tracks[0].uri] };
		}

		await this.client.request("/me/player/play", {
			method: "PUT",
			query: { device_id: device.id },
			body,
		});

		return {
			device_name: device.name,
			status: body ? "track_started" : "playback_resumed",
		};
	}

	/**
	 * Pauses playback on the active or named Spotify device.
	 *
	 * @param {{ device_name?: unknown }} [input] - Optional target device.
	 * @returns {Promise<object>} Pause outcome.
	 */
	async pauseMusic(input = {}) {
		const device = await this.getPreferredDevice(
			typeof input.device_name === "string" ? input.device_name : undefined,
		);
		await this.client.request("/me/player/pause", {
			method: "PUT",
			query: { device_id: device.id },
		});

		return {
			device_name: device.name,
			status: "playback_paused",
		};
	}

	/**
	 * Skips to the next item on the active or named Spotify device.
	 *
	 * @param {{ device_name?: unknown }} [input] - Optional target device.
	 * @returns {Promise<object>} Skip outcome.
	 */
	async skipTrack(input = {}) {
		const device = await this.getPreferredDevice(
			typeof input.device_name === "string" ? input.device_name : undefined,
		);
		await this.client.request("/me/player/next", {
			method: "POST",
			query: { device_id: device.id },
		});

		return {
			device_name: device.name,
			status: "track_skipped",
		};
	}

	/**
	 * Returns a compact playback snapshot for the local user interface.
	 *
	 * @returns {Promise<object>} Current player state without raw Spotify payloads.
	 */
	async getPlaybackState() {
		const playback = await this.client.request("/me/player");

		if (!playback) {
			return {
				is_playing: false,
				status: "no_active_playback",
			};
		}

		const item = playback.item;

		return {
			album: item?.album?.name ?? null,
			artists: Array.isArray(item?.artists)
				? item.artists.map((artist) => artist.name).join(", ")
				: null,
			device_name: playback.device?.name ?? null,
			external_url: item?.external_urls?.spotify ?? null,
			is_playing: Boolean(playback.is_playing),
			name: item?.name ?? null,
			status: "playback_available",
		};
	}

	/**
	 * Resolves track search phrases to playable Spotify track URIs.
	 *
	 * @param {string[]} searches - Search phrases, ideally including artist and title.
	 * @returns {Promise<{ tracks: object[], missedSearches: string[] }>} Resolution outcome.
	 */
	async resolveTracks(searches) {
		const tracks = [];
		const missedSearches = [];

		for (const search of searches) {
			const response = await this.client.request("/search", {
				query: {
					limit: 1,
					q: search,
					type: "track",
				},
			});
			const track = response?.tracks?.items?.[0];

			if (track?.uri) {
				tracks.push({
					name: track.name,
					uri: track.uri,
				});
			} else {
				missedSearches.push(search);
			}
		}

		const uniqueTracks = [
			...new Map(tracks.map((track) => [track.uri, track])).values(),
		];

		if (uniqueTracks.length === 0) {
			throw new AppError("Spotify could not find any of those songs.", {
				code: "NO_TRACKS_FOUND",
				status: 404,
			});
		}

		return { missedSearches, tracks: uniqueTracks };
	}

	/**
	 * Selects the named device, active device, or first unrestricted device.
	 *
	 * @param {string | undefined} requestedName - Optional case-insensitive device name.
	 * @returns {Promise<object>} Selected Spotify device.
	 */
	async getPreferredDevice(requestedName) {
		const response = await this.client.request("/me/player/devices");
		const availableDevices = (response?.devices ?? []).filter(
			(device) => device.id && !device.is_restricted,
		);
		let selectedDevice;

		if (requestedName?.trim()) {
			const normalizedName = requestedName.trim().toLowerCase();
			selectedDevice = availableDevices.find((device) =>
				device.name.toLowerCase().includes(normalizedName),
			);

			if (!selectedDevice) {
				throw new AppError(
					`Spotify device “${requestedName.trim()}” is not available.`,
					{
						code: "SPOTIFY_DEVICE_NOT_FOUND",
						status: 404,
					},
				);
			}
		} else {
			selectedDevice =
				availableDevices.find((device) => device.is_active) ??
				availableDevices[0];
		}

		if (!selectedDevice) {
			throw new AppError(
				"No Spotify playback device is available. Open Spotify on a phone, computer, or speaker and try again.",
				{
					code: "NO_SPOTIFY_DEVICE",
					status: 409,
				},
			);
		}

		return selectedDevice;
	}

	/**
	 * Starts a Spotify context such as a newly created playlist.
	 *
	 * @param {string} contextUri - Spotify context URI.
	 * @param {string | undefined} deviceName - Optional target device name.
	 * @returns {Promise<void>}
	 */
	async playContext(contextUri, deviceName) {
		const device = await this.getPreferredDevice(deviceName);
		await this.client.request("/me/player/play", {
			method: "PUT",
			query: { device_id: device.id },
			body: { context_uri: contextUri },
		});
	}
}
