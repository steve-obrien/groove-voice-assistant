import assert from "node:assert/strict";
import test from "node:test";

import { SpotifyService } from "../src/spotify-service.js";

/**
 * Records Spotify requests and returns deterministic queued responses.
 */
class FakeSpotifyClient {
	/**
	 * Creates a fake Spotify client.
	 *
	 * @param {any[]} responses - Responses returned in request order.
	 */
	constructor(responses) {
		this.calls = [];
		this.responses = [...responses];
	}

	/**
	 * Records one request and returns the next configured response.
	 *
	 * @param {string} endpoint - Spotify API path.
	 * @param {object} [options] - Request options.
	 * @returns {Promise<any>} Next fake response.
	 */
	async request(endpoint, options = {}) {
		this.calls.push({ endpoint, options });
		return this.responses.shift();
	}
}

/**
 * Builds a minimal Spotify search response for one resolved track.
 *
 * @param {string} uri - Spotify track URI.
 * @param {string} name - Track name.
 * @returns {object} Search response payload.
 */
function trackSearchResponse(uri, name) {
	return {
		tracks: {
			items: [{ name, uri }],
		},
	};
}

test("creates a playlist through the current 2026 Spotify endpoints and starts it", async () => {
	const client = new FakeSpotifyClient([
		trackSearchResponse("spotify:track:first", "First"),
		trackSearchResponse("spotify:track:second", "Second"),
		{
			external_urls: { spotify: "https://open.spotify.com/playlist/new" },
			id: "playlist-new",
			uri: "spotify:playlist:playlist-new",
		},
		null,
		{
			devices: [
				{
					id: "device-1",
					is_active: true,
					is_restricted: false,
					name: "Office speaker",
				},
			],
		},
		null,
	]);
	const service = new SpotifyService(client);

	const result = await service.createPlaylistAndPlay({
		name: "Morning funk",
		description: "Bright funk for early starts.",
		track_searches: ["First Artist", "Second Artist"],
	});

	assert.equal(result.status, "playlist_created");
	assert.equal(result.track_count, 2);
	assert.equal(result.playback_started, true);
	assert.deepEqual(
		client.calls.map((call) => call.endpoint),
		[
			"/search",
			"/search",
			"/me/playlists",
			"/playlists/playlist-new/items",
			"/me/player/devices",
			"/me/player/play",
		],
	);
	assert.deepEqual(client.calls[3].options.body, {
		uris: ["spotify:track:first", "spotify:track:second"],
	});
	assert.deepEqual(client.calls[5].options.body, {
		context_uri: "spotify:playlist:playlist-new",
	});
});

test("keeps a newly created playlist when no playback device is available", async () => {
	const client = new FakeSpotifyClient([
		trackSearchResponse("spotify:track:first", "First"),
		{
			external_urls: { spotify: "https://open.spotify.com/playlist/new" },
			id: "playlist-new",
			uri: "spotify:playlist:playlist-new",
		},
		null,
		{ devices: [] },
	]);
	const service = new SpotifyService(client);

	const result = await service.createPlaylistAndPlay({
		name: "Morning funk",
		track_searches: ["First Artist"],
	});

	assert.equal(result.status, "playlist_created");
	assert.equal(result.playback_started, false);
	assert.match(result.playback_message, /Open Spotify/i);
});

test("adds songs to the most recently created playlist", async () => {
	const client = new FakeSpotifyClient([
		trackSearchResponse("spotify:track:first", "First"),
		{
			external_urls: { spotify: "https://open.spotify.com/playlist/new" },
			id: "playlist-new",
			uri: "spotify:playlist:playlist-new",
		},
		null,
		{ devices: [] },
		trackSearchResponse("spotify:track:extra", "Extra"),
		null,
	]);
	const service = new SpotifyService(client);

	await service.createPlaylistAndPlay({
		name: "Morning funk",
		track_searches: ["First Artist"],
	});
	const result = await service.addSongsToPlaylist({
		track_searches: ["Extra Artist"],
	});

	assert.equal(result.playlist_id, "playlist-new");
	assert.equal(result.added_count, 1);
	assert.equal(client.calls.at(-1).endpoint, "/playlists/playlist-new/items");
});

test("removes resolved songs from the most recently created playlist", async () => {
	const client = new FakeSpotifyClient([
		trackSearchResponse("spotify:track:first", "First"),
		{
			external_urls: { spotify: "https://open.spotify.com/playlist/new" },
			id: "playlist-new",
			uri: "spotify:playlist:playlist-new",
		},
		null,
		{ devices: [] },
		trackSearchResponse("spotify:track:first", "First"),
		null,
	]);
	const service = new SpotifyService(client);

	await service.createPlaylistAndPlay({
		name: "Morning funk",
		track_searches: ["First Artist"],
	});
	const result = await service.removeSongsFromPlaylist({
		track_searches: ["First Artist"],
	});

	assert.equal(result.playlist_id, "playlist-new");
	assert.equal(result.removed_count, 1);
	assert.deepEqual(client.calls.at(-1), {
		endpoint: "/playlists/playlist-new/items",
		options: {
			method: "DELETE",
			body: {
				items: [{ uri: "spotify:track:first" }],
			},
		},
	});
});

test("uses the active device for resume, pause, and skip controls", async () => {
	const activeDeviceResponse = {
		devices: [
			{
				id: "device-1",
				is_active: true,
				is_restricted: false,
				name: "Office speaker",
			},
		],
	};
	const client = new FakeSpotifyClient([
		activeDeviceResponse,
		null,
		activeDeviceResponse,
		null,
		activeDeviceResponse,
		null,
	]);
	const service = new SpotifyService(client);

	await service.playMusic();
	await service.pauseMusic();
	await service.skipTrack();

	assert.deepEqual(
		client.calls.map((call) => [call.options.method ?? "GET", call.endpoint]),
		[
			["GET", "/me/player/devices"],
			["PUT", "/me/player/play"],
			["GET", "/me/player/devices"],
			["PUT", "/me/player/pause"],
			["GET", "/me/player/devices"],
			["POST", "/me/player/next"],
		],
	);
});
