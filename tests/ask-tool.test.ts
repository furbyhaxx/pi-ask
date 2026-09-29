import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { registerAskTool } from "../src/ask-tool.ts";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { getAskConfigStore } from "../src/config/store.ts";
import {
	createRemoteAskRuntime,
	PI_ASK_BRIDGE_READY_EVENT,
	PI_ASK_COMPLETED_EVENT,
	PI_ASK_STARTED_EVENT,
	PI_ASK_SUBMIT_EVENT,
	type RemoteAskCompletedEvent,
	type RemoteAskStartedEvent,
} from "../src/remote-ask.ts";
import { AskOptionSchema, AskParamsSchema } from "../src/schema.ts";
import type { AskParams } from "../src/types.ts";

const NON_INTERACTIVE_MESSAGE_RE =
	/Needs user input: ask_user requires interactive TUI mode\./;
const FIRST_QUESTION_RE = /1\. Goal: What should I optimize for\?/;
const SPEED_OPTION_RE = /- Speed \[speed\]/;
const CUSTOM_OPTION_RE = /- Type your own \[custom\]/;
const DUPLICATE_ID_RE =
	/questions\[1\]\.id: Question 2: duplicate question id "scope"/;
const PREVIEW_RULE_RE =
	/questions\[0\]\.options\[0\]\.preview: Question 1, option 1: preview questions require preview text for every option; add preview text or use type "single" instead/;
const MISSING_OPTION_VALUE_RE =
	/questions\[0\]\.options\[0\]\.value: Question 1, option 1: value is required/;
const EMPTY_QUESTIONS_RE = /questions: At least one question is required/;
const INVALID_TYPE_RE =
	/questions\[0\]\.type: Question 1: invalid type "grid"; expected "single", "multi", or "preview"/;
const HAS_UI = "hasUI";
const noop = () => {
	// intentional test callback
};

function registerMockTool(
	remoteAsk?: ReturnType<typeof createRemoteAskRuntime>
) {
	const tools: Record<string, unknown>[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	registerAskTool(
		{
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
			registerTool(tool: unknown) {
				tools.push(tool as Record<string, unknown>);
			},
		} as never,
		remoteAsk
	);
	return {
		entries,
		tool: tools[0] as {
			execute: (...args: any[]) => Promise<any>;
			parameters: Record<string, any>;
			prepareArguments: (args: unknown) => unknown;
			promptGuidelines: string[];
			renderCall: (args: unknown, theme: any) => { text: string };
			renderResult: (
				result: any,
				options: unknown,
				theme: any
			) => { text: string };
		},
	};
}

class TestEventBus {
	readonly events: Array<{ channel: string; data: unknown }> = [];
	private readonly handlers = new Map<string, Array<(data: unknown) => void>>();

	emit(channel: string, data: unknown): void {
		this.events.push({ channel, data });
		for (const handler of this.handlers.get(channel) ?? []) {
			handler(data);
		}
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		const handlers = this.handlers.get(channel) ?? [];
		handlers.push(handler);
		this.handlers.set(channel, handlers);
		return () => {
			this.handlers.set(
				channel,
				(this.handlers.get(channel) ?? []).filter(
					(candidate) => candidate !== handler
				)
			);
		};
	}
}

function makeCtx(hasUi: boolean, mode = hasUi ? "tui" : "print"): unknown {
	return { [HAS_UI]: hasUi, mode };
}

function sampleParams(): AskParams {
	return {
		title: "Clarify next step",
		questions: [
			{
				id: "goal",
				label: "Goal",
				prompt: "What should I optimize for?",
				options: [
					{ value: "speed", label: "Speed" },
					{ value: "safety", label: "Safety" },
				],
			},
		],
	};
}

test("ask option schema and tool guidance support grounded recommendations", () => {
	const { tool } = registerMockTool();

	assert.equal(
		Value.Check(AskOptionSchema, {
			value: "small",
			label: "Small",
			description: "Lowest implementation risk",
			recommended: true,
		}),
		true
	);
	assert(
		tool.promptGuidelines.some(
			(guideline) =>
				guideline.includes("grounded preferences") &&
				guideline.includes("description")
		)
	);
});

test("ask params schema constrains question types", () => {
	assert.equal(
		Value.Check(AskParamsSchema, {
			questions: [
				{
					id: "layout",
					prompt: "Choose a layout",
					type: "grid",
					options: [{ value: "compact", label: "Compact" }],
				},
			],
		}),
		false
	);
});

test("ask tool stores valid payloads as soon as they are called", async () => {
	const { entries, tool } = registerMockTool();
	const params = sampleParams();

	await tool.execute("call-1", params, undefined, noop, makeCtx(false));

	assert.equal(entries.length, 1);
	assert.equal(entries[0].customType, "ask:payload");
	assert.deepEqual(entries[0].data, {
		version: 1,
		source: "tool",
		params,
		sourceEntryId: "call-1",
		timestamp: (entries[0].data as { timestamp: number }).timestamp,
	});
});

test("ask tool returns pending questions in non-interactive mode", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		sampleParams(),
		undefined,
		noop,
		makeCtx(false)
	);

	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.mode, "submit");
	assert.deepEqual(result.details.questions, [
		{
			id: "goal",
			label: "Goal",
			prompt: "What should I optimize for?",
			type: "single",
		},
	]);
	assert.deepEqual(result.details.answers, {});
	assert.match(result.content[0].text, NON_INTERACTIVE_MESSAGE_RE);
	assert.match(result.content[0].text, FIRST_QUESTION_RE);
	assert.match(result.content[0].text, SPEED_OPTION_RE);
	assert.match(result.content[0].text, CUSTOM_OPTION_RE);
});

test("ask tool waits for a headless bridge answer and returns normalized details", async () => {
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	bus.emit(PI_ASK_BRIDGE_READY_EVENT, { version: 1 });
	bus.on(PI_ASK_STARTED_EVENT, (data) => {
		const event = data as RemoteAskStartedEvent;
		bus.emit(PI_ASK_SUBMIT_EVENT, {
			version: 1,
			requestId: "bridge-request-1",
			flowId: event.flowId,
			response: {
				kind: "answer",
				answers: { goal: { values: ["speed"] } },
			},
		});
	});
	const { tool } = registerMockTool(remoteAsk);

	const result = await tool.execute(
		"call-1",
		sampleParams(),
		undefined,
		noop,
		makeCtx(false, "rpc")
	);

	assert.equal(result.details.cancelled, false);
	assert.deepEqual(result.details.answers.goal, {
		values: ["speed"],
		labels: ["Speed"],
		indices: [1],
		customText: undefined,
		note: undefined,
		optionNotes: undefined,
	});
	const started = bus.events.find(
		(event) => event.channel === PI_ASK_STARTED_EVENT
	)?.data as RemoteAskStartedEvent;
	assert.equal(started.title, "Clarify next step");
	assert.equal(started.questions[0]?.options[0]?.value, "speed");
	assert.equal(started.flowId, "tool:call-1");
	const completed = bus.events.find(
		(event) => event.channel === PI_ASK_COMPLETED_EVENT
	)?.data as RemoteAskCompletedEvent;
	assert.equal(completed.result.cancelled, false);
	remoteAsk.disposeAll();
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
});

test("headless bridge can cancel an ask", async () => {
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	bus.emit(PI_ASK_BRIDGE_READY_EVENT, { version: 1 });
	bus.on(PI_ASK_STARTED_EVENT, (data) => {
		const event = data as RemoteAskStartedEvent;
		bus.emit(PI_ASK_SUBMIT_EVENT, {
			version: 1,
			requestId: "bridge-cancel-request",
			flowId: event.flowId,
			response: { kind: "cancel" },
		});
	});
	const { tool } = registerMockTool(remoteAsk);

	const result = await tool.execute(
		"cancel-call",
		sampleParams(),
		undefined,
		noop,
		makeCtx(false, "rpc")
	);

	assert.equal(result.details.cancelled, true);
	remoteAsk.disposeAll();
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
});

test("headless remote asks cancel when aborted or when configured timeout expires", async () => {
	const bus = new TestEventBus();
	const remoteAsk = createRemoteAskRuntime(bus as never);
	bus.emit(PI_ASK_BRIDGE_READY_EVENT, { version: 1 });
	const { tool } = registerMockTool(remoteAsk);
	const abortController = new AbortController();
	bus.on(PI_ASK_STARTED_EVENT, () => abortController.abort());
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);

	const aborted = await tool.execute(
		"abort-call",
		sampleParams(),
		abortController.signal,
		noop,
		makeCtx(false, "rpc")
	);
	assert.equal(aborted.details.cancelled, true);

	getAskConfigStore().setConfig({
		...DEFAULT_ASK_CONFIG,
		remoteAsk: { timeoutMs: 1 },
	});
	const timedOut = await tool.execute(
		"timeout-call",
		sampleParams(),
		undefined,
		noop,
		makeCtx(false, "rpc")
	);
	assert.equal(timedOut.details.cancelled, true);
	remoteAsk.disposeAll();
	getAskConfigStore().setConfig(DEFAULT_ASK_CONFIG);
});

test("ask tool does not open custom UI outside TUI mode", async () => {
	const { tool } = registerMockTool();
	let customOpened = false;

	const result = await tool.execute("call-1", sampleParams(), undefined, noop, {
		[HAS_UI]: true,
		mode: "rpc",
		ui: {
			custom() {
				customOpened = true;
			},
		},
	});

	assert.equal(customOpened, false);
	assert.equal(result.details.cancelled, true);
	assert.match(result.content[0].text, NON_INTERACTIVE_MESSAGE_RE);
});

test("ask tool includes custom answer fallback for preview questions", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		{
			title: "Clarify",
			questions: [
				{
					id: "layout",
					label: "Layout",
					prompt: "Which layout?",
					type: "preview",
					options: [{ value: "compact", label: "Compact", preview: "A" }],
				},
			],
		},
		undefined,
		noop,
		makeCtx(false)
	);

	assert.match(result.content[0].text, CUSTOM_OPTION_RE);
});

test("ask tool rejects invalid payloads before UI opens with structured issues", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		{
			title: "Clarify",
			questions: [
				{
					id: "scope",
					prompt: "Pick scope",
					options: [{ value: "small", label: "Small" }],
				},
				{
					id: "scope",
					prompt: "Pick tone",
					options: [{ value: "direct", label: "Direct" }],
				},
			],
		},
		undefined,
		noop,
		makeCtx(true)
	);

	assert.equal(result.details.cancelled, true);
	assert.equal(result.details.mode, "submit");
	assert.equal(result.details.questions.length, 0);
	assert.deepEqual(result.details.error, {
		kind: "invalid_input",
		issues: [
			{
				path: "questions[1].id",
				message: 'Question 2: duplicate question id "scope"',
			},
		],
	});
	assert.match(result.content[0].text, DUPLICATE_ID_RE);
});

test("ask tool reports missing option values with structured issues", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		{
			title: "Clarify",
			questions: [
				{
					id: "api_style",
					prompt: "Pick API style",
					options: [{ label: "REST" } as never],
				},
			],
		},
		undefined,
		noop,
		makeCtx(true)
	);

	assert.equal(result.details.cancelled, true);
	assert.deepEqual(result.details.error, {
		kind: "invalid_input",
		issues: [
			{
				path: "questions[0].options[0].value",
				message: "Question 1, option 1: value is required",
			},
		],
	});
	assert.match(result.content[0].text, MISSING_OPTION_VALUE_RE);
});

test("ask tool reports empty questions with structured issues", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		{
			title: "Clarify",
			questions: [],
		},
		undefined,
		noop,
		makeCtx(true)
	);

	assert.equal(result.details.cancelled, true);
	assert.deepEqual(result.details.error, {
		kind: "invalid_input",
		issues: [
			{
				path: "questions",
				message: "At least one question is required",
			},
		],
	});
	assert.match(result.content[0].text, EMPTY_QUESTIONS_RE);
});

test("ask tool reports invalid question types with structured issues", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		{
			title: "Clarify",
			questions: [
				{
					id: "layout",
					prompt: "Pick layout",
					type: "grid" as never,
					options: [{ value: "compact", label: "Compact" }],
				},
			],
		},
		undefined,
		noop,
		makeCtx(true)
	);

	assert.equal(result.details.cancelled, true);
	assert.deepEqual(result.details.error, {
		kind: "invalid_input",
		issues: [
			{
				path: "questions[0].type",
				message:
					'Question 1: invalid type "grid"; expected "single", "multi", or "preview"',
			},
		],
	});
	assert.match(result.content[0].text, INVALID_TYPE_RE);
});

test("ask tool reports preview validation with structured issues", async () => {
	const { tool } = registerMockTool();

	const result = await tool.execute(
		"call-1",
		{
			title: "Clarify",
			questions: [
				{
					id: "layout",
					prompt: "Pick layout",
					type: "preview",
					options: [{ value: "compact", label: "Compact", preview: "   " }],
				},
			],
		},
		undefined,
		noop,
		makeCtx(true)
	);

	assert.equal(result.details.cancelled, true);
	assert.deepEqual(result.details.error, {
		kind: "invalid_input",
		issues: [
			{
				path: "questions[0].options[0].preview",
				message:
					'Question 1, option 1: preview questions require preview text for every option; add preview text or use type "single" instead',
			},
		],
	});
	assert.match(result.content[0].text, PREVIEW_RULE_RE);
});

test("ask tool accepts blank optional presentation fields", async () => {
	const { tool } = registerMockTool();
	const params: AskParams = {
		title: "   ",
		questions: [
			{
				id: "scope",
				label: "  ",
				prompt: "Pick scope",
				options: [
					{
						value: "small",
						label: "Small",
						description: " ",
						preview: "\t",
					},
				],
			},
		],
	};
	assert.equal(Value.Check(AskParamsSchema, params), true);
	const result = await tool.execute(
		"call-blank-optionals",
		params,
		undefined,
		noop,
		makeCtx(false)
	);

	assert.equal(result.details.error, undefined);
	assert.equal(result.details.title, undefined);
	assert.equal(result.details.questions[0].label, "Q1");
});

test("ask tool prepares missing and blank option labels before schema validation", async () => {
	const { tool } = registerMockTool();
	const raw = {
		questions: [
			{
				id: "encryption",
				prompt: "Choose encryption",
				options: [
					{ value: "region-local-kms-reencrypt-dek" },
					{ value: "follow_up", label: "  " },
					{ value: "existing", label: "Existing label" },
				],
			},
		],
	};

	assert.equal(Value.Check(AskParamsSchema, raw), false);
	const prepared = tool.prepareArguments(raw) as AskParams;
	assert.equal(Value.Check(AskParamsSchema, prepared), true);
	assert.deepEqual(
		prepared.questions[0]?.options.map((option) => option.label),
		["Region local kms reencrypt dek", "Follow up", "Existing label"]
	);

	const result = await tool.execute(
		"call-prepared-labels",
		prepared,
		undefined,
		noop,
		makeCtx(false)
	);
	assert.equal(result.details.error, undefined);
});

test("public schema requires semantic identifiers and labels", () => {
	const { tool } = registerMockTool();
	assert.deepEqual(tool.parameters.required, ["questions"]);
	const questionSchema = tool.parameters.properties.questions.items;
	assert.deepEqual(questionSchema.required, ["id", "prompt", "options"]);
	assert.deepEqual(questionSchema.properties.options.items.required, [
		"value",
		"label",
	]);

	const missingLabel = {
		questions: [
			{
				id: "scope",
				prompt: "Pick scope",
				options: [{ value: "small" }],
			},
		],
	};
	assert.equal(Value.Check(AskParamsSchema, missingLabel), false);
});

test("ask tool transcript renderers summarize call and cancelled result", () => {
	const { tool } = registerMockTool();
	const theme = {
		bold: (text: string) => text,
		fg: (_token: string, text: string) => text,
	};

	const callText = tool.renderCall(
		{
			questions: [
				{ label: "Goal", options: [], prompt: "Q?", id: "goal" },
				{ label: "Tone", options: [], prompt: "Q?", id: "tone" },
			],
		},
		theme
	).text;
	assert.equal(callText, "ask_user 2 question(s) (Goal, Tone)");

	const resultText = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				cancelled: true,
				mode: "submit",
				questions: [],
				answers: {},
			},
		},
		undefined,
		theme
	).text;
	assert.equal(resultText, "Cancelled");

	const invalidText = tool.renderResult(
		{
			content: [{ type: "text", text: "ignored" }],
			details: {
				cancelled: true,
				mode: "submit",
				questions: [],
				answers: {},
				error: {
					kind: "invalid_input",
					issues: [],
				},
			},
		},
		undefined,
		theme
	).text;
	assert.equal(invalidText, "Invalid tool payload");

	const schemaErrorText = tool.renderResult(
		{
			content: [
				{
					type: "text",
					text: 'Validation failed for tool "ask_user": missing label',
				},
			],
			details: {},
		},
		undefined,
		theme
	).text;
	assert.equal(
		schemaErrorText,
		'Validation failed for tool "ask_user": missing label'
	);
});
