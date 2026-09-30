import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_ASK_CONFIG,
	normalizeAskConfig,
} from "../src/config/defaults.ts";
import { getAskKeyBindings, matchesBinding } from "../src/constants/keymaps.ts";

test("ask key bindings are memoized per config value", () => {
	const first = getAskKeyBindings(DEFAULT_ASK_CONFIG);
	assert.equal(getAskKeyBindings(DEFAULT_ASK_CONFIG), first);

	const remapped = normalizeAskConfig({
		...DEFAULT_ASK_CONFIG,
		keymaps: {
			...DEFAULT_ASK_CONFIG.keymaps,
			main: { ...DEFAULT_ASK_CONFIG.keymaps.main, confirm: ["y"] },
		},
	});
	const second = getAskKeyBindings(remapped);

	assert.notEqual(second, first);
	assert.notEqual(second["main.confirm"], first["main.confirm"]);
	assert.ok(matchesBinding("y", second["main.confirm"]));
	assert.ok(!matchesBinding("enter", second["main.confirm"]));
});
