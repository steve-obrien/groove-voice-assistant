import assert from "node:assert/strict";
import test from "node:test";

import {
	createRealtimeCall,
	createRealtimeSessionConfig,
} from "../src/realtime.js";

const appConfig = {
	openAiApiKey: "test-key-never-sent-to-browser",
	openAiModel: "gpt-realtime-2.1",
	openAiVoice: "marin",
	projectRoot: "/test/groove",
};

test("builds a realtime voice session with every Spotify function", () => {
	const session = createRealtimeSessionConfig(appConfig);

	assert.equal(session.type, "realtime");
	assert.equal(session.model, "gpt-realtime-2.1");
	assert.deepEqual(session.output_modalities, ["audio"]);
	assert.deepEqual(session.audio.input.noise_reduction, {
		type: "near_field",
	});
	assert.deepEqual(session.audio.input.turn_detection, {
		type: "semantic_vad",
	});
	assert.match(session.instructions, /Background music/);
	assert.deepEqual(
		session.tools.map((tool) => tool.name),
		[
			"create_playlist_and_play",
			"play_music",
			"pause_music",
			"skip_track",
			"add_songs_to_playlist",
			"remove_songs_from_playlist",
		],
	);
});

test("creates a unified WebRTC call while keeping the standard API key server-side", async () => {
	/**
	 * Verifies the outbound OpenAI request and returns an SDP answer.
	 *
	 * @param {string} url - OpenAI endpoint URL.
	 * @param {RequestInit} options - Fetch request options.
	 * @returns {Promise<Response>} Fake SDP response.
	 */
	async function fakeFetch(url, options) {
		assert.equal(url, "https://api.openai.com/v1/realtime/calls");
		assert.equal(options.headers.Authorization, `Bearer ${appConfig.openAiApiKey}`);
		assert.match(options.headers["OpenAI-Safety-Identifier"], /^[a-f0-9]{64}$/);
		assert.equal(options.body.get("sdp"), "v=0\r\ntest-offer");
		const session = JSON.parse(options.body.get("session"));
		assert.equal(session.model, "gpt-realtime-2.1");

		return new Response("v=0\r\ntest-answer", {
			status: 201,
			headers: { "Content-Type": "application/sdp" },
		});
	}

	const answer = await createRealtimeCall(
		"v=0\r\ntest-offer",
		appConfig,
		fakeFetch,
	);

	assert.equal(answer, "v=0\r\ntest-answer");
});
