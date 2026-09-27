import assert from "node:assert/strict";
import test from "node:test";
import askExtension from "../src/index.ts";

const CONFIGURATION_DOC_PATH_RE = /first read .+docs[\\/]configuration\.md/;
const FORCED_PROMPT_PREFIX_RE = /^forced system prompt\n\nWhen the user asks/;

function registerExtensionHandlers() {
	const handlers: Record<string, (event: never) => unknown> = {};
	const pi = {
		on(event: string, handler: (event: never) => unknown) {
			handlers[event] = handler;
		},
		events: { on: () => () => undefined },
		registerCommand: () => undefined,
		registerTool: () => undefined,
	} as never;

	askExtension(pi);
	return handlers;
}

test("configuration guidance uses a structured system prompt section", () => {
	const handlers = registerExtensionHandlers();
	const sections: Record<string, string> = {
		existing: "existing section",
	};
	const event = {
		systemPrompt: "existing system prompt",
		systemPromptOptions: { sections },
	};
	const result = handlers.before_agent_start?.(event as never);

	assert.equal(result, undefined);
	assert.equal(event.systemPrompt, "existing system prompt");
	assert.equal(event.systemPromptOptions.sections.existing, "existing section");
	assert.match(
		event.systemPromptOptions.sections["pi-ask"] ?? "",
		CONFIGURATION_DOC_PATH_RE
	);
});

test("configuration guidance extends an existing forced system prompt", () => {
	const handlers = registerExtensionHandlers();
	const event = {
		systemPromptOptions: {
			forceSystemPrompt: "forced system prompt",
			sections: { existing: "existing section" },
		},
	};
	const result = handlers.before_agent_start?.(event as never);

	assert.equal(result, undefined);
	assert.match(
		event.systemPromptOptions.forceSystemPrompt,
		FORCED_PROMPT_PREFIX_RE
	);
	assert.match(
		event.systemPromptOptions.forceSystemPrompt,
		CONFIGURATION_DOC_PATH_RE
	);
	assert.deepEqual(event.systemPromptOptions.sections, {
		existing: "existing section",
	});
});
