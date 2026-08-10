const ui = {
	assistantAudio: document.querySelector("#assistant-audio"),
	connectionStatus: document.querySelector("#connection-status"),
	endSessionButton: document.querySelector("#end-session-button"),
	liveBadge: document.querySelector("#live-badge"),
	playerContent: document.querySelector("#player-content"),
	playerEmpty: document.querySelector("#player-empty"),
	playingIndicator: document.querySelector("#playing-indicator"),
	spotifyConnect: document.querySelector("#spotify-connect"),
	spotifyPill: document.querySelector("#spotify-pill"),
	textForm: document.querySelector("#text-form"),
	textPrompt: document.querySelector("#text-prompt"),
	trackArtist: document.querySelector("#track-artist"),
	trackDevice: document.querySelector("#track-device"),
	trackLink: document.querySelector("#track-link"),
	transcript: document.querySelector("#transcript"),
	voiceButton: document.querySelector("#voice-button"),
	voiceLabel: document.querySelector("#voice-label"),
};

const INTERACTION_MODE = {
	PUSH_TO_TALK: "push-to-talk",
	VOICE_ACTIVITY: "voice-activity",
};
const MINIMUM_PUSH_TO_TALK_MS = 200;

const state = {
	assistantMessage: null,
	dataChannel: null,
	interactionMode: INTERACTION_MODE.VOICE_ACTIVITY,
	mediaStream: null,
	outputAudioPlaying: false,
	peerConnection: null,
	playerIsPlaying: false,
	processedToolCalls: new Set(),
	pushToTalkActive: false,
	pushToTalkStartedAt: 0,
	responseInProgress: false,
	status: null,
};

/**
 * Extracts a useful message from an API error payload.
 *
 * @param {unknown} payload - Parsed response payload.
 * @param {string} fallback - Fallback error message.
 * @returns {string} User-safe error message.
 */
function getErrorMessage(payload, fallback) {
	if (
		typeof payload === "object" &&
		payload !== null &&
		typeof payload.error?.message === "string"
	) {
		return payload.error.message;
	}

	return fallback;
}

/**
 * Fetches JSON and throws a user-safe error for unsuccessful responses.
 *
 * @param {string} url - Same-origin API URL.
 * @param {RequestInit} [options] - Fetch options.
 * @returns {Promise<any>} Parsed payload, or null for an empty response.
 */
async function requestJson(url, options = {}) {
	const response = await fetch(url, options);

	if (response.status === 204) {
		return null;
	}

	let payload = null;

	try {
		payload = await response.json();
	} catch {
		// The response status still provides the fallback error path below.
	}

	if (!response.ok) {
		throw new Error(getErrorMessage(payload, "The request could not be completed."));
	}

	return payload;
}

/**
 * Updates the visible assistant connection message.
 *
 * @param {string} message - Status message.
 * @param {"default" | "error" | "success"} [tone="default"] - Visual tone.
 * @returns {void}
 */
function setConnectionStatus(message, tone = "default") {
	ui.connectionStatus.textContent = message;
	ui.connectionStatus.classList.toggle("is-error", tone === "error");
	ui.connectionStatus.classList.toggle("is-success", tone === "success");
}

/**
 * Renders the microphone control for the current connection and interaction mode.
 *
 * @param {boolean} connected - Whether the assistant is connected.
 * @returns {void}
 */
function renderVoiceControl(connected) {
	const pushToTalk =
		connected && state.interactionMode === INTERACTION_MODE.PUSH_TO_TALK;
	const talking = pushToTalk && state.pushToTalkActive;

	ui.voiceButton.classList.toggle("is-connected", connected);
	ui.voiceButton.classList.toggle("is-push-to-talk", pushToTalk);
	ui.voiceButton.classList.toggle("is-talking", talking);
	ui.voiceButton.setAttribute("aria-pressed", String(talking || (connected && !pushToTalk)));
	ui.voiceLabel.textContent = !connected
		? "Start listening"
		: pushToTalk
			? talking
				? "Listening…"
				: "Hold to talk"
			: "Stop listening";
	ui.endSessionButton.hidden = !pushToTalk;
	ui.liveBadge.textContent = connected ? "Live" : "Idle";
	ui.liveBadge.classList.toggle("is-live", connected);
}

/**
 * Toggles the visual state for an active Realtime connection.
 *
 * @param {boolean} connected - Whether the assistant is connected.
 * @returns {void}
 */
function setAssistantConnected(connected) {
	renderVoiceControl(connected);
}

/**
 * Enables or mutes every captured microphone track without ending permission.
 *
 * @param {boolean} enabled - Whether captured audio should be sent to WebRTC.
 * @returns {void}
 */
function setMicrophoneEnabled(enabled) {
	for (const track of state.mediaStream?.getAudioTracks() ?? []) {
		track.enabled = enabled;
	}
}

/**
 * Updates the Spotify status controls from the server's safe status response.
 *
 * @param {object} status - Server status payload.
 * @returns {void}
 */
function renderStatus(status) {
	const spotifyConnected = Boolean(status.spotify_connected);
	ui.spotifyPill.classList.toggle("status-pill-online", spotifyConnected);
	ui.spotifyPill.classList.toggle("status-pill-offline", !spotifyConnected);
	ui.spotifyPill.lastElementChild.textContent = spotifyConnected
		? "Spotify connected"
		: "Spotify offline";
	ui.spotifyConnect.textContent = spotifyConnected
		? "Reconnect Spotify"
		: "Connect Spotify";

	if (!status.openai_configured) {
		setConnectionStatus("Add OPENAI_API_KEY to .env.local.", "error");
	} else if (!status.spotify_configured) {
		setConnectionStatus(
			"Add your Spotify app credentials to .env.local.",
			"error",
		);
	} else if (!spotifyConnected) {
		setConnectionStatus("Connect Spotify, then start the assistant.");
	} else if (!state.peerConnection) {
		setConnectionStatus("Ready. Start the assistant and speak naturally.", "success");
	}
}

/**
 * Refreshes OpenAI and Spotify connection readiness.
 *
 * @returns {Promise<object>} Current safe server status.
 */
async function refreshStatus() {
	state.status = await requestJson("/api/status");
	renderStatus(state.status);
	return state.status;
}

/**
 * Appends one safe text entry to the conversation transcript.
 *
 * @param {"assistant" | "user"} role - Message author.
 * @param {string} text - Message text.
 * @returns {HTMLParagraphElement} Created message element.
 */
function appendTranscript(role, text) {
	const entry = document.createElement("div");
	const speaker = document.createElement("span");
	const message = document.createElement("p");

	entry.className = `transcript-entry ${role}-entry`;
	speaker.className = "speaker";
	speaker.textContent = role === "assistant" ? "Groove" : "You";
	message.textContent = text;
	entry.append(speaker, message);
	ui.transcript.append(entry);
	ui.transcript.scrollTop = ui.transcript.scrollHeight;

	return message;
}

/**
 * Streams one assistant transcript delta into the active message.
 *
 * @param {string} delta - Transcript delta.
 * @returns {void}
 */
function appendAssistantDelta(delta) {
	if (!state.assistantMessage) {
		state.assistantMessage = appendTranscript("assistant", "");
	}

	state.assistantMessage.textContent += delta;
	ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

/**
 * Sends a JSON client event over the active Realtime data channel.
 *
 * @param {object} event - Realtime client event.
 * @returns {void}
 */
function sendRealtimeEvent(event) {
	if (!state.dataChannel || state.dataChannel.readyState !== "open") {
		throw new Error("Start the voice assistant first.");
	}

	state.dataChannel.send(JSON.stringify(event));
}

/**
 * Requests a new assistant response and immediately tracks its interruptible state.
 *
 * @param {object} [response] - Optional per-response Realtime configuration.
 * @returns {void}
 */
function requestAssistantResponse(response) {
	const event = { type: "response.create" };

	if (response) {
		event.response = response;
	}

	sendRealtimeEvent(event);
	state.responseInProgress = true;
}

/**
 * Cancels active generation and clears any assistant audio still being played.
 *
 * @returns {void}
 */
function cancelActiveResponse() {
	if (!state.responseInProgress && !state.outputAudioPlaying) {
		return;
	}

	if (state.responseInProgress) {
		sendRealtimeEvent({ type: "response.cancel" });
	}

	if (state.outputAudioPlaying) {
		sendRealtimeEvent({ type: "output_audio_buffer.clear" });
	}

	state.outputAudioPlaying = false;
	state.responseInProgress = false;
}

/**
 * Switches the live session from automatic voice activity detection to push-to-talk.
 *
 * @returns {boolean} Whether push-to-talk is now active.
 */
function enablePushToTalk() {
	if (state.interactionMode === INTERACTION_MODE.PUSH_TO_TALK) {
		return true;
	}

	if (!state.dataChannel || state.dataChannel.readyState !== "open") {
		return false;
	}

	cancelActiveResponse();
	sendRealtimeEvent({
		type: "session.update",
		session: {
			type: "realtime",
			audio: {
				input: {
					turn_detection: null,
				},
			},
		},
	});
	sendRealtimeEvent({ type: "input_audio_buffer.clear" });
	state.interactionMode = INTERACTION_MODE.PUSH_TO_TALK;
	state.pushToTalkActive = false;
	state.pushToTalkStartedAt = 0;
	setMicrophoneEnabled(false);
	renderVoiceControl(true);
	setConnectionStatus(
		"Music is playing — hold the microphone button while you speak.",
		"success",
	);

	return true;
}

/**
 * Determines whether a successful Spotify tool result confirms audible playback.
 *
 * @param {string} toolName - Executed Spotify tool name.
 * @param {object} result - Successful tool result.
 * @returns {boolean} Whether the tool started or resumed playback.
 */
function toolStartedPlayback(toolName, result = {}) {
	if (toolName === "create_playlist_and_play") {
		return result.playback_started === true;
	}

	return (
		toolName === "play_music" &&
		["track_started", "playback_resumed"].includes(result.status)
	);
}

/**
 * Begins a user-controlled microphone turn and interrupts any assistant response.
 *
 * @param {PointerEvent | KeyboardEvent} inputEvent - Press event from the voice control.
 * @returns {void}
 */
function beginPushToTalk(inputEvent) {
	if (
		state.interactionMode !== INTERACTION_MODE.PUSH_TO_TALK ||
		state.dataChannel?.readyState !== "open" ||
		state.pushToTalkActive
	) {
		return;
	}

	if (inputEvent.type === "pointerdown" && inputEvent.button !== 0) {
		return;
	}

	inputEvent.preventDefault();
	cancelActiveResponse();
	sendRealtimeEvent({ type: "input_audio_buffer.clear" });
	setMicrophoneEnabled(true);
	state.pushToTalkActive = true;
	state.pushToTalkStartedAt = performance.now();
	renderVoiceControl(true);
	setConnectionStatus("Listening — release when you finish speaking.", "success");

	if (inputEvent.type === "pointerdown") {
		ui.voiceButton.setPointerCapture(inputEvent.pointerId);
	}
}

/**
 * Commits a completed push-to-talk turn and asks the assistant to respond.
 *
 * @param {PointerEvent | KeyboardEvent} inputEvent - Release event from the voice control.
 * @returns {void}
 */
function endPushToTalk(inputEvent) {
	if (!state.pushToTalkActive) {
		return;
	}

	inputEvent.preventDefault();
	setMicrophoneEnabled(false);
	const heldFor = performance.now() - state.pushToTalkStartedAt;
	state.pushToTalkActive = false;
	state.pushToTalkStartedAt = 0;
	renderVoiceControl(true);

	if (heldFor < MINIMUM_PUSH_TO_TALK_MS) {
		sendRealtimeEvent({ type: "input_audio_buffer.clear" });
		setConnectionStatus("Hold the microphone button while you speak.");
		return;
	}

	sendRealtimeEvent({ type: "input_audio_buffer.commit" });
	requestAssistantResponse();
	setConnectionStatus("Thinking…");
}

/**
 * Discards a push-to-talk turn interrupted by the browser or pointer system.
 *
 * @param {Event} inputEvent - Cancellation event from the voice control.
 * @returns {void}
 */
function cancelPushToTalk(inputEvent) {
	if (!state.pushToTalkActive) {
		return;
	}

	inputEvent.preventDefault();
	setMicrophoneEnabled(false);
	state.pushToTalkActive = false;
	state.pushToTalkStartedAt = 0;
	sendRealtimeEvent({ type: "input_audio_buffer.clear" });
	renderVoiceControl(true);
	setConnectionStatus("Hold the microphone button while you speak.");
}

/**
 * Executes one model-requested Spotify function on the trusted server.
 *
 * @param {object} functionCall - Completed Realtime function call item.
 * @returns {Promise<void>}
 */
async function executeToolCall(functionCall) {
	let arguments_ = {};

	try {
		arguments_ = JSON.parse(functionCall.arguments || "{}");
	} catch {
		arguments_ = {};
	}

	let output;

	try {
		const payload = await requestJson(
			`/api/tools/${encodeURIComponent(functionCall.name)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(arguments_),
			},
		);
		output = { ok: true, ...payload.result };

		if (toolStartedPlayback(functionCall.name, payload.result)) {
			enablePushToTalk();
		}

		await refreshPlayer();
	} catch (error) {
		output = { ok: false, error: error.message };
		setConnectionStatus(error.message, "error");
	}

	sendRealtimeEvent({
		type: "conversation.item.create",
		item: {
			type: "function_call_output",
			call_id: functionCall.call_id,
			output: JSON.stringify(output),
		},
	});
}

/**
 * Executes every new tool call from a completed model response.
 *
 * @param {object} response - Completed Realtime response.
 * @returns {Promise<void>}
 */
async function handleToolCalls(response) {
	const functionCalls = (response.output ?? []).filter(
		(item) => item.type === "function_call" && item.call_id,
	);
	let executedCall = false;

	for (const functionCall of functionCalls) {
		if (state.processedToolCalls.has(functionCall.call_id)) {
			continue;
		}

		state.processedToolCalls.add(functionCall.call_id);
		await executeToolCall(functionCall);
		executedCall = true;
	}

	if (executedCall) {
		requestAssistantResponse();
	}
}

/**
 * Reports an asynchronous event-processing error without breaking the session.
 *
 * @param {unknown} error - Rejected operation.
 * @returns {void}
 */
function handleAsyncError(error) {
	const message = error instanceof Error ? error.message : "Realtime event failed.";
	state.responseInProgress = false;
	setConnectionStatus(message, "error");
}

/**
 * Handles one parsed server event from OpenAI Realtime.
 *
 * @param {object} event - Realtime server event.
 * @returns {Promise<void>}
 */
async function handleRealtimeEvent(event) {
	if (event.type === "response.created") {
		state.responseInProgress = true;
		return;
	}

	if (event.type === "output_audio_buffer.started") {
		state.outputAudioPlaying = true;
		return;
	}

	if (
		["output_audio_buffer.cleared", "output_audio_buffer.stopped"].includes(
			event.type,
		)
	) {
		state.outputAudioPlaying = false;
		return;
	}

	if (event.type === "conversation.item.input_audio_transcription.completed") {
		if (event.transcript?.trim()) {
			appendTranscript("user", event.transcript.trim());
		}
		return;
	}

	if (event.type === "response.output_audio_transcript.delta") {
		appendAssistantDelta(event.delta ?? "");
		return;
	}

	if (event.type === "response.output_audio_transcript.done") {
		state.assistantMessage = null;
		return;
	}

	if (event.type === "response.done") {
		state.responseInProgress = false;
		await handleToolCalls(event.response ?? {});

		if (state.interactionMode === INTERACTION_MODE.PUSH_TO_TALK) {
			setConnectionStatus("Hold the microphone button while you speak.");
		}

		return;
	}

	if (event.type === "error") {
		state.responseInProgress = false;
		setConnectionStatus(
			event.error?.message || "The realtime session reported an error.",
			"error",
		);
	}
}

/**
 * Parses and dispatches one WebRTC data channel message.
 *
 * @param {MessageEvent} messageEvent - Data channel message event.
 * @returns {void}
 */
function handleRealtimeMessage(messageEvent) {
	try {
		const event = JSON.parse(messageEvent.data);
		handleRealtimeEvent(event).catch(handleAsyncError);
	} catch {
		setConnectionStatus("A realtime event could not be read.", "error");
	}
}

/**
 * Handles the Realtime control channel becoming ready.
 *
 * @returns {void}
 */
function handleDataChannelOpen() {
	setAssistantConnected(true);
	setConnectionStatus("Listening — speak naturally.", "success");

	if (state.playerIsPlaying) {
		enablePushToTalk();
	}

	requestAssistantResponse({
		instructions:
			"Greet the user in one short sentence and say you can make a playlist or control Spotify.",
	});
}

/**
 * Handles the Realtime control channel closing.
 *
 * @returns {void}
 */
function handleDataChannelClose() {
	const hadActiveConnection = Boolean(state.peerConnection);
	disconnectAssistant();

	if (hadActiveConnection) {
		setConnectionStatus("Voice session ended.");
	}
}

/**
 * Routes remote Realtime audio into the autoplay audio element.
 *
 * @param {RTCTrackEvent} trackEvent - Peer connection track event.
 * @returns {void}
 */
function handleRemoteTrack(trackEvent) {
	ui.assistantAudio.srcObject = trackEvent.streams[0];
}

/**
 * Responds to failed or closed WebRTC peer states.
 *
 * @returns {void}
 */
function handlePeerConnectionStateChange() {
	const connectionState = state.peerConnection?.connectionState;

	if (["failed", "closed"].includes(connectionState)) {
		disconnectAssistant();
		setConnectionStatus("Voice connection closed. Start it again to reconnect.");
	}
}

/**
 * Stops microphone capture and closes the active Realtime session.
 *
 * @returns {void}
 */
function disconnectAssistant() {
	setMicrophoneEnabled(false);

	for (const track of state.mediaStream?.getTracks() ?? []) {
		track.stop();
	}

	if (state.dataChannel && state.dataChannel.readyState !== "closed") {
		state.dataChannel.close();
	}

	if (state.peerConnection) {
		state.peerConnection.close();
	}

	state.assistantMessage = null;
	state.dataChannel = null;
	state.interactionMode = INTERACTION_MODE.VOICE_ACTIVITY;
	state.mediaStream = null;
	state.outputAudioPlaying = false;
	state.peerConnection = null;
	state.processedToolCalls.clear();
	state.pushToTalkActive = false;
	state.pushToTalkStartedAt = 0;
	state.responseInProgress = false;
	ui.assistantAudio.srcObject = null;
	setAssistantConnected(false);
	setConnectionStatus("Voice session ended.");
}

/**
 * Starts browser microphone capture and a GA Realtime WebRTC session.
 *
 * @returns {Promise<void>}
 */
async function connectAssistant() {
	const status = await refreshStatus();

	if (!status.openai_configured) {
		throw new Error("OPENAI_API_KEY is not configured.");
	}

	if (!status.spotify_configured) {
		throw new Error("Add your Spotify app credentials to .env.local first.");
	}

	if (!status.spotify_connected) {
		throw new Error("Connect Spotify before starting the assistant.");
	}

	setConnectionStatus("Requesting microphone access…");
	const mediaStream = await navigator.mediaDevices.getUserMedia({
		audio: {
			autoGainControl: true,
			channelCount: 1,
			echoCancellation: true,
			noiseSuppression: true,
		},
	});
	const peerConnection = new RTCPeerConnection();
	const dataChannel = peerConnection.createDataChannel("oai-events");

	state.mediaStream = mediaStream;
	state.peerConnection = peerConnection;
	state.dataChannel = dataChannel;

	peerConnection.addEventListener("track", handleRemoteTrack);
	peerConnection.addEventListener(
		"connectionstatechange",
		handlePeerConnectionStateChange,
	);
	dataChannel.addEventListener("open", handleDataChannelOpen);
	dataChannel.addEventListener("close", handleDataChannelClose);
	dataChannel.addEventListener("message", handleRealtimeMessage);

	for (const track of mediaStream.getAudioTracks()) {
		peerConnection.addTrack(track, mediaStream);
	}

	const offer = await peerConnection.createOffer();
	await peerConnection.setLocalDescription(offer);
	setConnectionStatus("Opening secure voice session…");
	const response = await fetch("/api/realtime/session", {
		method: "POST",
		headers: { "Content-Type": "application/sdp" },
		body: offer.sdp,
	});
	const answerSdp = await response.text();

	if (!response.ok) {
		let payload = null;

		try {
			payload = JSON.parse(answerSdp);
		} catch {
			// Use the safe fallback below.
		}

		throw new Error(
			getErrorMessage(payload, "The realtime voice session could not start."),
		);
	}

	await peerConnection.setRemoteDescription({
		type: "answer",
		sdp: answerSdp,
	});
}

/**
 * Toggles the voice assistant from its main microphone button.
 *
 * @returns {Promise<void>}
 */
async function handleVoiceButtonClick() {
	if (state.interactionMode === INTERACTION_MODE.PUSH_TO_TALK) {
		return;
	}

	if (state.peerConnection) {
		disconnectAssistant();
		return;
	}

	try {
		await connectAssistant();
	} catch (error) {
		disconnectAssistant();
		setConnectionStatus(error.message, "error");
	}
}

/**
 * Starts push-to-talk for keyboard users pressing Space or Enter.
 *
 * @param {KeyboardEvent} keyboardEvent - Voice button keydown event.
 * @returns {void}
 */
function handleVoiceButtonKeyDown(keyboardEvent) {
	if (!["Enter", " "].includes(keyboardEvent.key) || keyboardEvent.repeat) {
		return;
	}

	beginPushToTalk(keyboardEvent);
}

/**
 * Ends push-to-talk for keyboard users releasing Space or Enter.
 *
 * @param {KeyboardEvent} keyboardEvent - Voice button keyup event.
 * @returns {void}
 */
function handleVoiceButtonKeyUp(keyboardEvent) {
	if (!["Enter", " "].includes(keyboardEvent.key)) {
		return;
	}

	endPushToTalk(keyboardEvent);
}

/**
 * Sends a typed message into the active Realtime conversation.
 *
 * @param {string} text - User message.
 * @returns {void}
 */
function sendTextPrompt(text) {
	const normalizedText = text.trim();

	if (!normalizedText) {
		return;
	}

	appendTranscript("user", normalizedText);
	sendRealtimeEvent({
		type: "conversation.item.create",
		item: {
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: normalizedText }],
		},
	});
	requestAssistantResponse();
}

/**
 * Handles the optional text input fallback.
 *
 * @param {SubmitEvent} submitEvent - Form submission event.
 * @returns {void}
 */
function handleTextSubmit(submitEvent) {
	submitEvent.preventDefault();

	try {
		sendTextPrompt(ui.textPrompt.value);
		ui.textPrompt.value = "";
	} catch (error) {
		setConnectionStatus(error.message, "error");
	}
}

/**
 * Copies a suggested prompt into the active session or text field.
 *
 * @param {MouseEvent} clickEvent - Prompt chip click event.
 * @returns {void}
 */
function handlePromptChipClick(clickEvent) {
	const prompt = clickEvent.currentTarget.dataset.prompt ?? "";

	if (state.dataChannel?.readyState === "open") {
		sendTextPrompt(prompt);
	} else {
		ui.textPrompt.value = prompt;
		ui.textPrompt.focus();
		setConnectionStatus("Start the assistant, then send this request.");
	}
}

/**
 * Executes a direct player control from the now-playing card.
 *
 * @param {MouseEvent} clickEvent - Control button click event.
 * @returns {Promise<void>}
 */
async function handlePlayerControl(clickEvent) {
	const toolName = clickEvent.currentTarget.dataset.tool;

	try {
		const payload = await requestJson(`/api/tools/${encodeURIComponent(toolName)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});

		const startedPlayback = toolStartedPlayback(toolName, payload.result);

		if (startedPlayback) {
			enablePushToTalk();
		} else {
			setConnectionStatus("Spotify updated.", "success");
		}

		await refreshPlayer();
	} catch (error) {
		setConnectionStatus(error.message, "error");
	}
}

/**
 * Renders the latest compact Spotify playback state.
 *
 * @param {object | null} player - Player state from the server.
 * @returns {void}
 */
function renderPlayer(player) {
	const hasTrack = Boolean(player?.name);
	state.playerIsPlaying = Boolean(player?.is_playing);
	ui.playerEmpty.hidden = hasTrack;
	ui.playerContent.hidden = !hasTrack;
	ui.playingIndicator.classList.toggle("is-paused", !player?.is_playing);

	if (state.playerIsPlaying) {
		enablePushToTalk();
	}

	if (!hasTrack) {
		ui.playerEmpty.textContent = state.status?.spotify_connected
			? "Nothing playing yet"
			: "Connect Spotify to see playback";
		return;
	}

	ui.trackLink.textContent = player.name;
	ui.trackLink.href = player.external_url || "https://open.spotify.com/";
	ui.trackArtist.textContent = [player.artists, player.album]
		.filter(Boolean)
		.join(" — ");
	ui.trackDevice.textContent = player.device_name
		? `Playing on ${player.device_name}`
		: "Spotify playback";
}

/**
 * Refreshes the current Spotify player without disrupting the main UI.
 *
 * @returns {Promise<void>}
 */
async function refreshPlayer() {
	try {
		const player = await requestJson("/api/spotify/player");
		renderPlayer(player);
	} catch {
		renderPlayer(null);
	}
}

/**
 * Displays Spotify OAuth callback feedback and removes it from the URL.
 *
 * @returns {void}
 */
function handleOAuthFeedback() {
	const url = new URL(window.location.href);
	const spotifyResult = url.searchParams.get("spotify");

	if (spotifyResult === "connected") {
		setConnectionStatus("Spotify connected. You can start the assistant.", "success");
	} else if (spotifyResult === "error") {
		setConnectionStatus(
			url.searchParams.get("message") || "Spotify could not be connected.",
			"error",
		);
	}

	if (spotifyResult) {
		window.history.replaceState({}, "", "/");
	}
}

/**
 * Registers UI handlers and loads the initial application state.
 *
 * @returns {Promise<void>}
 */
async function initialize() {
	ui.voiceButton.addEventListener("click", handleVoiceButtonClick);
	ui.voiceButton.addEventListener("keydown", handleVoiceButtonKeyDown);
	ui.voiceButton.addEventListener("keyup", handleVoiceButtonKeyUp);
	ui.voiceButton.addEventListener("pointercancel", cancelPushToTalk);
	ui.voiceButton.addEventListener("pointerdown", beginPushToTalk);
	ui.voiceButton.addEventListener("pointerup", endPushToTalk);
	ui.endSessionButton.addEventListener("click", disconnectAssistant);
	ui.textForm.addEventListener("submit", handleTextSubmit);
	window.addEventListener("blur", cancelPushToTalk);

	for (const chip of document.querySelectorAll(".prompt-chip")) {
		chip.addEventListener("click", handlePromptChipClick);
	}

	for (const control of document.querySelectorAll("[data-tool]")) {
		control.addEventListener("click", handlePlayerControl);
	}

	handleOAuthFeedback();

	try {
		await refreshStatus();
		await refreshPlayer();
	} catch (error) {
		setConnectionStatus(error.message, "error");
	}

	window.setInterval(refreshPlayer, 5_000);
}

initialize().catch(handleAsyncError);
