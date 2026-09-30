import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import { resetAskConfigStore } from "../src/config/store.ts";
import type { AskResult } from "../src/types.ts";
import { runAskFlow } from "../src/ui/controller.ts";

const fakeTui = {
	requestRender() {
		// the test drives renders through handleInput
	},
	terminal: { columns: 100, rows: 40 },
};

const fakeTheme = {
	bg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
	fg(_color: string, text: string) {
		return text;
	},
};

async function useConfigWithAutoSubmit(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-ask-flow-"));
	await mkdir(join(root, "extensions"), { recursive: true });
	await writeFile(
		join(root, "extensions", "eko24ive-pi-ask.json"),
		JSON.stringify({
			schemaVersion: 6,
			answer: DEFAULT_ASK_CONFIG.answer,
			behaviour: {
				...DEFAULT_ASK_CONFIG.behaviour,
				autoSubmitWhenAnsweredWithoutNotes: true,
			},
			keymaps: DEFAULT_ASK_CONFIG.keymaps,
			notifications: { ...DEFAULT_ASK_CONFIG.notifications, enabled: false },
		})
	);
	process.env.PI_CODING_AGENT_DIR = root;
	resetAskConfigStore();
}

interface AskComponent {
	handleInput(data: string): void;
}

type MountCallback = (
	tui: unknown,
	theme: unknown,
	keybindings: unknown,
	done: (result: AskResult) => void
) => AskComponent;

async function startFlow(params: Parameters<typeof runAskFlow>[1]): Promise<{
	component: AskComponent;
	isFinished: () => boolean;
	result: () => AskResult | undefined;
}> {
	let finished = false;
	let result: AskResult | undefined;
	let mount: (component: AskComponent) => void = () => undefined;
	const mounted = new Promise<AskComponent>((resolve) => {
		mount = resolve;
	});
	const ctx = {
		cwd: tmpdir(),
		mode: "tui",
		ui: {
			custom(callback: MountCallback) {
				const component = callback(fakeTui, fakeTheme, {}, (value) => {
					finished = true;
					result = value;
				});
				mount(component);
				return component;
			},
			notify() {
				// notifications are disabled in the test config
			},
			setWorkingVisible() {
				// no working row to toggle in the test harness
			},
		},
	} as never as Parameters<typeof runAskFlow>[0];

	runAskFlow(ctx, params).catch(() => undefined);

	return {
		component: await mounted,
		isFinished: () => finished,
		result: () => result,
	};
}

const SINGLE_QUESTION_PARAMS = {
	questions: [
		{
			id: "q1",
			label: "Pick",
			prompt: "Pick one",
			options: [{ value: "a", label: "Option A" }],
		},
	],
};

test("auto-submit resolves the flow when the answering transition lands on the review tab", async () => {
	await useConfigWithAutoSubmit();
	const flow = await startFlow(SINGLE_QUESTION_PARAMS);

	flow.component.handleInput("1");

	assert.equal(flow.isFinished(), true);
	assert.equal(flow.result()?.cancelled, false);
	assert.deepEqual(flow.result()?.answers.q1?.values, ["a"]);
});

test("a completed ask flow resolves at most once", async () => {
	await useConfigWithAutoSubmit();
	const flow = await startFlow(SINGLE_QUESTION_PARAMS);

	flow.component.handleInput("1");
	const first = flow.result();
	assert.ok(first);

	flow.component.handleInput("2");

	assert.equal(flow.result(), first);
});
