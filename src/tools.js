/**
 * Returns the Realtime function definitions available to the assistant.
 *
 * @returns {object[]} OpenAI Realtime tool definitions.
 */
export function createToolDefinitions() {
	const optionalDevice = {
		device_name: {
			description:
				"Optional Spotify Connect device name, such as Kitchen speaker. Omit it to use the active device.",
			type: "string",
		},
	};

	return [
		{
			type: "function",
			name: "create_playlist_and_play",
			description:
				"Create a private Spotify playlist from specific song searches and immediately start it. Choose 8 to 12 suitable songs before calling this tool for a broad mood request.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: {
						description: "A short, appealing playlist name.",
						type: "string",
					},
					description: {
						description: "A concise description of the playlist mood.",
						type: "string",
					},
					track_searches: {
						description:
							"Specific Spotify track searches. Prefer one song title plus artist per entry.",
						items: { type: "string" },
						maxItems: 12,
						minItems: 1,
						type: "array",
					},
					...optionalDevice,
				},
				required: ["name", "track_searches"],
			},
		},
		{
			type: "function",
			name: "play_music",
			description:
				"Resume Spotify playback, or start a specific song when a search query is supplied.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					query: {
						description:
							"Optional song search containing title and artist. Omit to resume playback.",
						type: "string",
					},
					...optionalDevice,
				},
			},
		},
		{
			type: "function",
			name: "pause_music",
			description: "Pause or stop Spotify playback.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: { ...optionalDevice },
			},
		},
		{
			type: "function",
			name: "skip_track",
			description: "Skip to the next Spotify track.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: { ...optionalDevice },
			},
		},
		{
			type: "function",
			name: "add_songs_to_playlist",
			description:
				"Add specific songs to a Spotify playlist. Omit playlist_id to use the playlist most recently created by this assistant session.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					playlist_id: {
						description: "Optional Spotify playlist ID.",
						type: "string",
					},
					track_searches: {
						description:
							"Specific Spotify track searches. Prefer one song title plus artist per entry.",
						items: { type: "string" },
						maxItems: 12,
						minItems: 1,
						type: "array",
					},
				},
				required: ["track_searches"],
			},
		},
		{
			type: "function",
			name: "remove_songs_from_playlist",
			description:
				"Remove specific songs from a Spotify playlist. Omit playlist_id to use the playlist most recently created by this assistant session.",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					playlist_id: {
						description: "Optional Spotify playlist ID.",
						type: "string",
					},
					track_searches: {
						description:
							"Specific Spotify track searches to remove. Prefer one song title plus artist per entry.",
						items: { type: "string" },
						maxItems: 12,
						minItems: 1,
						type: "array",
					},
				},
				required: ["track_searches"],
			},
		},
	];
}

/**
 * Creates the trusted server-side handlers for Realtime tool calls.
 *
 * @param {import("./spotify-service.js").SpotifyService} spotifyService - Spotify domain service.
 * @returns {Record<string, (arguments_: object) => Promise<object>>} Tool handlers keyed by function name.
 */
export function createToolHandlers(spotifyService) {
	/**
	 * Handles playlist creation and playback.
	 *
	 * @param {object} arguments_ - Validated tool arguments.
	 * @returns {Promise<object>} Tool result.
	 */
	async function createPlaylistAndPlay(arguments_) {
		return spotifyService.createPlaylistAndPlay(arguments_);
	}

	/**
	 * Handles starting or resuming playback.
	 *
	 * @param {object} arguments_ - Tool arguments.
	 * @returns {Promise<object>} Tool result.
	 */
	async function playMusic(arguments_) {
		return spotifyService.playMusic(arguments_);
	}

	/**
	 * Handles pausing playback.
	 *
	 * @param {object} arguments_ - Tool arguments.
	 * @returns {Promise<object>} Tool result.
	 */
	async function pauseMusic(arguments_) {
		return spotifyService.pauseMusic(arguments_);
	}

	/**
	 * Handles skipping the active track.
	 *
	 * @param {object} arguments_ - Tool arguments.
	 * @returns {Promise<object>} Tool result.
	 */
	async function skipTrack(arguments_) {
		return spotifyService.skipTrack(arguments_);
	}

	/**
	 * Handles appending songs to a playlist.
	 *
	 * @param {object} arguments_ - Tool arguments.
	 * @returns {Promise<object>} Tool result.
	 */
	async function addSongsToPlaylist(arguments_) {
		return spotifyService.addSongsToPlaylist(arguments_);
	}

	/**
	 * Handles removing songs from a playlist.
	 *
	 * @param {object} arguments_ - Tool arguments.
	 * @returns {Promise<object>} Tool result.
	 */
	async function removeSongsFromPlaylist(arguments_) {
		return spotifyService.removeSongsFromPlaylist(arguments_);
	}

	return {
		add_songs_to_playlist: addSongsToPlaylist,
		create_playlist_and_play: createPlaylistAndPlay,
		pause_music: pauseMusic,
		play_music: playMusic,
		remove_songs_from_playlist: removeSongsFromPlaylist,
		skip_track: skipTrack,
	};
}
