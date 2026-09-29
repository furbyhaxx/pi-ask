import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { appendAskPayload } from "./ask-payload-store.ts";
import {
	ASK_TOOL_DESCRIPTION,
	ASK_TOOL_PROMPT_GUIDELINES,
	invalidPayloadResponse,
	nonInteractiveResponse,
	renderAskToolCall,
	renderAskToolResult,
	successfulResponse,
	validateParams,
} from "./ask-tool-helpers.ts";
import { getAskConfigStore } from "./config/store.ts";
import {
	applyRemoteAskResponse,
	type RemoteAskResponse,
	type RemoteAskRuntime,
} from "./remote-ask.ts";
import { AskParamsSchema } from "./schema.ts";
import { prepareAskParams } from "./state/normalize.ts";
import { toAskResult } from "./state/result.ts";
import type { AskParams, AskResult, AskState } from "./types.ts";
import { runAskFlow } from "./ui/controller.ts";

export function registerAskTool(
	pi: ExtensionAPI,
	remoteAsk?: RemoteAskRuntime
) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: ASK_TOOL_DESCRIPTION,
		promptSnippet:
			"Clarify ambiguous or preference-sensitive decisions with a short interactive interview before proceeding",
		promptGuidelines: [...ASK_TOOL_PROMPT_GUIDELINES],
		parameters: AskParamsSchema,
		prepareArguments: (args) => prepareAskParams(args) as AskParams,
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			executeAskTool(
				pi,
				toolCallId,
				params as AskParams,
				signal,
				onUpdate,
				ctx,
				remoteAsk
			),
		renderCall: renderAskToolCall,
		renderResult: renderAskToolResult,
	});
}

async function executeAskTool(
	pi: Pick<ExtensionAPI, "appendEntry">,
	toolCallId: string,
	params: AskParams,
	signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
	remoteAsk?: RemoteAskRuntime
) {
	const config = await getAskConfigStore().getConfig();
	const validation = validateParams(params, {
		presentSingleAsMulti: config.behaviour.presentSingleAsMulti,
	});
	if (!validation.ok) {
		return invalidPayloadResponse(params, validation.issues);
	}
	appendAskPayload(pi, {
		params,
		source: "tool",
		sourceEntryId: toolCallId,
	});
	if (ctx.mode !== "tui") {
		if (remoteAsk?.hasBridge()) {
			const result = await waitForHeadlessAnswer(
				remoteAsk,
				validation.state,
				params,
				toolCallId,
				signal,
				config.remoteAsk.timeoutMs
			);
			return successfulResponse(result);
		}
		return nonInteractiveResponse(validation.state);
	}
	ctx.ui.setWorkingVisible(false);
	try {
		const result = await runAskFlow(ctx, params, {
			remote: remoteAsk
				? { runtime: remoteAsk, source: "tool", toolCallId }
				: undefined,
		});
		return successfulResponse(result);
	} finally {
		ctx.ui.setWorkingVisible(true);
	}
}

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

function waitForHeadlessAnswer(
	remoteAsk: RemoteAskRuntime,
	state: AskState,
	params: AskParams,
	toolCallId: string,
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined
): Promise<AskResult> {
	const cancelledResult = () => toAskResult({ ...state, cancelled: true });
	if (signal?.aborted) {
		return Promise.resolve(cancelledResult());
	}

	return new Promise((resolve) => {
		let completed = false;
		let flow: ReturnType<RemoteAskRuntime["startFlow"]> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutStartedAt = Date.now();

		const finish = (result: AskResult) => {
			if (completed) {
				return;
			}
			completed = true;
			if (timeout !== undefined) {
				clearTimeout(timeout);
			}
			signal?.removeEventListener("abort", onAbort);
			flow?.complete(result);
			resolve(result);
		};
		const onAbort = () => finish(cancelledResult());
		const scheduleTimeout = () => {
			if (timeoutMs === undefined) {
				return;
			}
			const remaining = timeoutMs - (Date.now() - timeoutStartedAt);
			if (remaining <= 0) {
				finish(cancelledResult());
				return;
			}
			timeout = setTimeout(
				scheduleTimeout,
				Math.min(remaining, MAX_TIMEOUT_DELAY_MS)
			);
		};

		flow = remoteAsk.startFlow({
			source: "tool",
			toolCallId,
			title: params.title,
			questions: state.questions,
			onSubmit(response: RemoteAskResponse) {
				const applied = applyRemoteAskResponse(state, response);
				if (!applied.ok) {
					return applied;
				}
				finish(toAskResult(applied.state));
				return { ok: true };
			},
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		scheduleTimeout();
	});
}
