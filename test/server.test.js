import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedRequestOrigin } from "../src/server.js";

test("allows the configured application origin", () => {
	assert.equal(
		isAllowedRequestOrigin(
			"http://127.0.0.1:3003",
			"http://127.0.0.1:3003",
		),
		true,
	);
});

test("allows localhost and explicit loopback aliases on the configured port", () => {
	assert.equal(
		isAllowedRequestOrigin(
			"http://localhost:3003",
			"http://127.0.0.1:3003",
		),
		true,
	);
	assert.equal(
		isAllowedRequestOrigin(
			"http://[::1]:3003",
			"http://127.0.0.1:3003",
		),
		true,
	);
});

test("rejects non-loopback hosts and mismatched ports", () => {
	assert.equal(
		isAllowedRequestOrigin(
			"http://example.invalid:3003",
			"http://127.0.0.1:3003",
		),
		false,
	);
	assert.equal(
		isAllowedRequestOrigin(
			"http://localhost:3000",
			"http://127.0.0.1:3003",
		),
		false,
	);
});
