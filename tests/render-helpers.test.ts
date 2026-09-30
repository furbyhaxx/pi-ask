import assert from "node:assert/strict";
import test from "node:test";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { DEFAULT_ASK_CONFIG } from "../src/config/defaults.ts";
import {
	fitToWidth,
	renderEditorBlock,
	renderFooterText,
} from "../src/ui/render-helpers.ts";

const ABC_PATTERN = /abc/;
const BORDER_PATTERN = /┌|└/;
const TYPE_YOUR_PATTERN = /Type your/;
const SELECTED_BG_PATTERN = /\{selectedBg\}/;

function mockTheme() {
	return {
		fg(color: string, text: string) {
			return `<${color}>${text}</${color}>`;
		},
		bg(color: string, text: string) {
			return `{${color}}${text}{/${color}}`;
		},
	};
}

test("renderEditorBlock strips editor borders", () => {
	const lines: string[] = [];
	renderEditorBlock({
		lines,
		editorLines: ["┌──┐", "abc", "└──┘"],
		width: 40,
		theme: mockTheme() as never,
		indent: "   ",
		availableWidth: 40,
	});

	assert.equal(lines.length, 1);
	assert.match(lines[0], ABC_PATTERN);
	assert.match(lines[0], SELECTED_BG_PATTERN);
	assert.doesNotMatch(lines[0], BORDER_PATTERN);
});

test("renderEditorBlock shows a muted placeholder when empty", () => {
	const lines: string[] = [];
	renderEditorBlock({
		lines,
		editorLines: ["┌──┐", "  ", "└──┘"],
		width: 40,
		theme: mockTheme() as never,
		indent: "   ",
		availableWidth: 40,
		placeholder: "Type your",
		isEmpty: true,
	});

	assert.equal(lines.length, 1);
	assert.match(lines[0], TYPE_YOUR_PATTERN);
	assert.match(lines[0], SELECTED_BG_PATTERN);
	assert.doesNotMatch(lines[0], BORDER_PATTERN);
});

test("renderEditorBlock reapplies background after editor reset sequences", () => {
	const lines: string[] = [];
	renderEditorBlock({
		lines,
		editorLines: ["┌──┐", "abc\x1b[7m \x1b[0m", "└──┘"],
		width: 40,
		theme: mockTheme() as never,
		indent: "   ",
		availableWidth: 40,
	});

	assert.equal(lines.length, 1);
	assert.match(lines[0], SELECTED_BG_PATTERN);
	assert(lines[0].includes("\x1b[0m{selectedBg}"));
});

test("editing footers do not advertise tab navigation", () => {
	assert.equal(
		renderFooterText(DEFAULT_ASK_CONFIG, "input"),
		" Enter submit · Esc close · ? settings"
	);
	assert.equal(
		renderFooterText(DEFAULT_ASK_CONFIG, "note"),
		" Enter save · Esc close · ? settings"
	);
});

test("editing footers use configured key labels", () => {
	const config = {
		...DEFAULT_ASK_CONFIG,
		keymaps: {
			...DEFAULT_ASK_CONFIG.keymaps,
			noteEditor: {
				...DEFAULT_ASK_CONFIG.keymaps.noteEditor,
				save: ["ctrl+k"],
				close: ["q"],
			},
		},
	};

	assert.equal(
		renderFooterText(config, "note"),
		" Ctrl+K save · Q close · ? settings"
	);
});

test("fitToWidth matches truncateToWidth for framed, ansi and oversized lines", () => {
	const cases: [string, number][] = [
		["", 10],
		["plain", 10],
		["exactly-10c", 10],
		["exactly-10c", 9],
		["─".repeat(10), 10],
		["─".repeat(12), 10],
		["\u001b[31mred\u001b[0m", 10],
		["\u001b[31mred\u001b[0m and more", 10],
		["tab\tseparated", 10],
		["wide 日本語 text here", 8],
		["emoji 👍🏽 cluster text", 6],
	];

	for (const [text, width] of cases) {
		assert.equal(
			fitToWidth(text, width),
			truncateToWidth(text, width),
			`mismatch for ${JSON.stringify(text)} at width ${width}`
		);
	}
});
