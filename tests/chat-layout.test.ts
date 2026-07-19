import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	type ExtensionAPI,
	getMarkdownTheme,
	initTheme,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import chatLayout from "../extensions/chat-layout.js";

interface Runtime {
	emit(name: string, event?: unknown): Promise<void>;
	shutdown(): Promise<void>;
	notify: ReturnType<typeof vi.fn>;
}

const createdDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => initTheme("dark"));
beforeEach(() => setConfig({}));

afterEach(() => {
	vi.useRealTimers();
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Reply" }],
		api: "openai-responses",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now() - 1_000,
		...overrides,
	};
}

function text(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

function stripAnsi(value: string): string {
	return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

const markerTheme = {
	fg(color: string, value: string): string {
		if (color === "accent") return `\x1b[31m${value}\x1b[39m`;
		if (color === "dim") return `\x1b[2m${value}\x1b[22m`;
		return value;
	},
	bold: (value: string) => value,
};

function setConfig(config: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-chat-layout-"));
	createdDirs.push(dir);
	const path = join(dir, "chat-layout.json");
	writeFileSync(path, JSON.stringify(config));
	process.env.PI_CODING_AGENT_DIR = dir;
	return path;
}

async function startRuntime(
	entries: unknown[] = [],
	thinking = "high",
	theme?: { fg(color: string, text: string): string; bold(text: string): string },
): Promise<Runtime> {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		getThinkingLevel: () => thinking,
	} as unknown as ExtensionAPI;
	chatLayout(pi);

	const notify = vi.fn();
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => entries },
		ui: { notify, theme },
	};
	const emit = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	await emit("session_start");
	return { emit, notify, shutdown: () => emit("session_shutdown") };
}

describe.sequential("chat layout renderer", () => {
	it("alternates alignment with configured icons and prefixed actor names", async () => {
		setConfig({
			layout: "alternating",
			icons: { user: "ME", assistant: "AI" },
			actors: {
				user: "Artem",
				assistant: { name: "Pi", mode: "prefix" },
			},
		});
		const now = Date.now();
		const userMessage = { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: now - 2_000 };
		const assistantMessage = assistant({ timestamp: now - 1_000 });
		const runtime = await startRuntime([
			{ type: "thinking_level_change", thinkingLevel: "high" },
			{ type: "message", message: userMessage, timestamp: new Date(now - 2_000).toISOString() },
			{ type: "message", message: assistantMessage, timestamp: new Date(now).toISOString() },
		]);

		const userLines = new UserMessageComponent(text(userMessage.content), getMarkdownTheme(), 1).render(80).map(stripAnsi);
		const assistantLines = new AssistantMessageComponent(
			assistantMessage,
			false,
			getMarkdownTheme(),
			"Thinking...",
			1,
		).render(80).map(stripAnsi);

		const userHeader = userLines.find((line) => line.includes("ME Artem"));
		const assistantHeader = assistantLines.find((line) => line.includes("AI Pi test-model"));
		expect(userHeader?.indexOf("ME Artem")).toBeGreaterThan(1);
		expect(assistantHeader?.indexOf("AI Pi test-model")).toBe(1);
		expect(assistantHeader).toContain("AI Pi test-model  ·  high");
		expect([...userLines, ...assistantLines].every((line) => visibleWidth(line) <= 80)).toBe(true);
		await runtime.shutdown();
	});

	it("styles assistant markdown without exposing source markers", async () => {
		const runtime = await startRuntime();
		const message = assistant({
			content: [{
				type: "text",
				text: [
					"### JavaScript",
					"",
					"Before",
					"",
					"```typescript",
					"const value = 42;",
					"```",
					"",
					"```text",
					"done",
					"```",
					"",
					"```",
					"plain",
					"```",
				].join("\n"),
			}],
		});
		const markdownTheme = {
			...getMarkdownTheme(),
			bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
		};
		const lines = new AssistantMessageComponent(message, false, markdownTheme, "Thinking...", 1)
			.render(80).map(stripAnsi);
		const rendered = lines.join("\n");
		expect(rendered).not.toContain("```");
		expect(rendered).not.toContain("### JavaScript");
		expect(rendered).toContain("› JavaScript");
		expect(rendered).toContain("<<~TS");
		const copiedCodeLine = lines.find((line) => line.includes("const value = 42;"));
		expect(copiedCodeLine?.trim()).toBe("const value = 42;");
		expect(rendered).toContain("<<~TXT");
		expect(rendered).toContain("<<~CODE");
		const trimmedLines = lines.map((line) => line.trim());
		expect(trimmedLines).toEqual(expect.arrayContaining(["TS", "TXT", "CODE"]));
		const openerLineIndex = trimmedLines.indexOf("<<~TS");
		const codeLineIndex = trimmedLines.indexOf("const value = 42;");
		const closerLineIndex = trimmedLines.indexOf("TS");
		expect(lines[codeLineIndex]?.search(/\S/)).toBe((lines[openerLineIndex]?.search(/\S/) ?? 0) + 1);
		expect(lines[closerLineIndex]?.search(/\S/)).toBe(lines[openerLineIndex]?.search(/\S/));
		expect(trimmedLines[openerLineIndex + 1]).toBe("");
		expect(trimmedLines[codeLineIndex + 1]).toBe("");
		expect(trimmedLines[codeLineIndex + 2]).toBe("TS");
		expect(rendered).not.toMatch(/[╭╰]/);
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		await runtime.shutdown();
	});

	it("keeps completed thinking on a static dim Matrix marker", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const runtime = await startRuntime([], "high", markerTheme);
		const completed = assistant({
			content: [
				{ type: "thinking", thinking: "Inspecting renderer behavior\n\nEvaluating alternatives" },
				{ type: "text", text: "*Done*" },
			],
		});
		await runtime.emit("message_start", { message: completed });
		await runtime.emit("message_end", { message: completed });
		const component = new AssistantMessageComponent(completed, false, getMarkdownTheme(), "Thinking...", 1);
		const first = component.render(32);
		const lines = first.map(stripAnsi);
		const thinkingLine = first.find((line) => line.includes("Inspecting"));
		const firstParagraph = lines.find((line) => line.includes("Inspecting"));
		const secondParagraph = lines.find((line) => line.includes("Evaluating"));
		expect(thinkingLine).toMatch(/\x1b\[2m[ｱ-ﾝ]{4} \x1b\[22m/);
		expect(lines.find((line) => line.includes("Inspecting"))).toMatch(/^ [ｱ-ﾝ]{4} Inspecting/);
		expect(lines.join("\n").match(/[ｱ-ﾝ]{4}/g)).toHaveLength(2);
		expect(firstParagraph?.slice(0, firstParagraph.indexOf("Inspecting")))
			.not.toBe(secondParagraph?.slice(0, secondParagraph.indexOf("Evaluating")));
		expect(lines.find((line) => line.includes("Done"))).not.toMatch(/[ｱ-ﾝ]{4}/);
		expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);

		vi.setSystemTime(40_000);
		expect(component.render(32)).toEqual(first);
		await runtime.shutdown();
	});

	it("renders accent Matrix frames that remain stable across streaming clones and advance every 400ms", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const runtime = await startRuntime([], "high", markerTheme);
		const active = assistant({
			content: [
				{ type: "thinking", thinking: "First line\ncontinuation\n\nSecond paragraph" },
				{ type: "text", text: "*Normal italic*" },
			],
		});
		await runtime.emit("message_start", { message: active });
		const component = new AssistantMessageComponent(active, false, getMarkdownTheme(), "Thinking...", 1);
		const firstRender = component.render(32);
		const frameZero = firstRender.map(stripAnsi);
		const firstLine = frameZero.find((line) => line.includes("First line"));
		const continuation = frameZero.find((line) => line.includes("continuation"));
		const secondParagraph = frameZero.find((line) => line.includes("Second paragraph"));
		const styledFirstLine = firstRender.find((line) => line.includes("First line"));
		const normalItalic = firstRender.find((line) => line.includes("Normal italic"));
		expect(component.render(32)).toEqual(firstRender);
		expect(styledFirstLine).toMatch(/\x1b\[31m[ｱ-ﾝ]{4} \x1b\[39m/);
		expect(normalItalic).not.toContain("\x1b[31m");
		expect(firstLine).toMatch(/^ [ｱ-ﾝ]{4} First line/);
		expect(continuation).toMatch(/^ {6}continuation/);
		expect(secondParagraph).toMatch(/^ [ｱ-ﾝ]{4} Second paragraph/);
		expect(firstLine?.slice(0, firstLine.indexOf("First line")))
			.not.toBe(secondParagraph?.slice(0, secondParagraph.indexOf("Second paragraph")));
		expect(frameZero.every((line) => visibleWidth(line) <= 32)).toBe(true);
		expect(visibleWidth(firstLine?.slice(0, firstLine.indexOf("First line")) ?? "")).toBe(6);

		const update = { ...active };
		await runtime.emit("message_update", { message: update });
		component.updateContent(update);
		expect(component.render(32).map(stripAnsi).find((line) => line.includes("First line"))).toBe(firstLine);

		vi.setSystemTime(400);
		const frameOne = component.render(32).map(stripAnsi);
		expect(frameOne.find((line) => line.includes("First line"))).not.toBe(firstLine);
		expect(frameOne.find((line) => line.includes("Second paragraph"))).not.toBe(secondParagraph);
		expect(frameOne.every((line) => visibleWidth(line) <= 32)).toBe(true);
		await runtime.shutdown();
	});

	it("gives distinct active thinking blocks independent deterministic sequences", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(800);
		const runtime = await startRuntime();
		const active = assistant({
			content: [
				{ type: "thinking", thinking: "Alpha block" },
				{ type: "text", text: "Between" },
				{ type: "thinking", thinking: "Beta block" },
			],
		});
		await runtime.emit("message_start", { message: active });
		const component = new AssistantMessageComponent(active, false, getMarkdownTheme(), "Thinking...", 1);
		const lines = component.render(32).map(stripAnsi);
		const alpha = lines.find((line) => line.includes("Alpha block"));
		const beta = lines.find((line) => line.includes("Beta block"));
		expect(alpha?.slice(0, alpha.indexOf("Alpha block")))
			.not.toBe(beta?.slice(0, beta.indexOf("Beta block")));
		expect(component.render(32).map(stripAnsi)).toEqual(lines);
		await runtime.shutdown();
	});

	it("can replace the assistant model with a configured actor name", async () => {
		setConfig({ actors: { assistant: { name: "Pi", mode: "replace" } } });
		const message = assistant();
		const runtime = await startRuntime();
		const lines = new AssistantMessageComponent(
			message,
			false,
			getMarkdownTheme(),
			"Thinking...",
			1,
		).render(80).map(stripAnsi);
		expect(lines).toContainEqual(expect.stringContaining("🤖 Pi  ·"));
		expect(lines.join("\n")).not.toContain("test-model");
		await runtime.shutdown();
	});

	it("supports a stacked layout", async () => {
		setConfig({ layout: "stacked" });
		const timestamp = Date.now();
		const userMessage = { role: "user", content: [{ type: "text", text: "Hello" }], timestamp };
		const runtime = await startRuntime([
			{ type: "message", message: userMessage, timestamp: new Date(timestamp).toISOString() },
		]);
		const lines = new UserMessageComponent("Hello", getMarkdownTheme(), 1).render(80).map(stripAnsi);
		const header = lines.find((line) => line.includes("👤 You"));
		expect(header?.startsWith(" ")).toBe(true);
		expect(header?.length).toBeLessThan(40);
		await runtime.shutdown();
	});

	it("keeps user timestamps stable and valid across runtime reloads", async () => {
		vi.useFakeTimers();
		const timestamp = Date.now() - 5_000;
		const userMessage = { role: "user", content: [{ type: "text", text: "Persisted" }], timestamp };
		const entries = [{ type: "message", message: userMessage, timestamp: new Date(timestamp).toISOString() }];
		const firstRuntime = await startRuntime(entries);
		const component = new UserMessageComponent("Persisted", getMarkdownTheme(), 1);
		const firstRender = component.render(80).map(stripAnsi);
		await firstRuntime.shutdown();

		vi.advanceTimersByTime(2_000);
		const secondRuntime = await startRuntime(entries);
		const secondRender = component.render(80).map(stripAnsi);
		expect(secondRender).toEqual(firstRender);
		expect(secondRender.join("\n")).not.toContain("Invalid Date");
		await secondRuntime.shutdown();
	});

	it("preserves thinking level across streaming message clones", async () => {
		setConfig({ icons: { thinking: { xhigh: "󱩖" } } });
		const runtime = await startRuntime([], "xhigh");
		const start = assistant({ content: [{ type: "text", text: "A" }] });
		await runtime.emit("message_start", { message: { ...start } });
		const component = new AssistantMessageComponent(start, false, getMarkdownTheme(), "Thinking...", 1);

		const update = { ...start, content: [{ type: "text" as const, text: "AB" }] };
		await runtime.emit("message_update", { message: update });
		component.updateContent(update);
		expect(component.render(80).map(stripAnsi).join("\n")).toContain("·  󱩖 xhigh  ·");
		expect(component.render(80).map(stripAnsi).join("\n")).not.toContain("0↑ 0↓");
		expect(component.render(80).map(stripAnsi).join("\n")).not.toContain("$0");

		const final = { ...update };
		await runtime.emit("message_end", { message: final });
		component.updateContent(final);
		expect(component.render(80).map(stripAnsi).join("\n")).toContain("·  󱩖 xhigh  ·");
		await runtime.shutdown();
	});

	it("keeps one blank line between a user bubble and the next divider", async () => {
		const now = Date.now();
		const userMessage = { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: now - 2_000 };
		const assistantMessage = assistant({ timestamp: now - 1_000 });
		const runtime = await startRuntime([
			{ type: "message", message: userMessage, timestamp: new Date(now - 2_000).toISOString() },
			{ type: "message", message: assistantMessage, timestamp: new Date(now).toISOString() },
		]);
		const user = new UserMessageComponent("Hello", getMarkdownTheme(), 1).render(60);
		const agent = new AssistantMessageComponent(assistantMessage, false, getMarkdownTheme(), "Thinking...", 1).render(60);
		const combined = [...user, ...agent].map(stripAnsi);
		const messageIndex = combined.findIndex((line) => line.includes("Hello"));
		const dividerIndex = combined.findIndex((line, index) => index > messageIndex && line.includes("────"));
		expect(dividerIndex - messageIndex).toBe(2);
		expect(user.join("")).toContain("\x1b]133;B\x07");
		await runtime.shutdown();
	});

	it("renders usage metadata and degrades headers by priority at narrow widths", async () => {
		setConfig({ header: { metadata: ["thinking", "time", "duration", "tokens", "cost"] } });
		const now = Date.now();
		const message = assistant({
			timestamp: now - 2_000,
			usage: {
				input: 1_234,
				output: 56,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_290,
				cost: { input: 0.003, output: 0.0012, cacheRead: 0, cacheWrite: 0, total: 0.0042 },
			},
		});
		const runtime = await startRuntime([
			{ type: "thinking_level_change", thinkingLevel: "high" },
			{ type: "message", message, timestamp: new Date(now).toISOString() },
		]);
		const component = new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking...", 1);
		const wide = component.render(160).map(stripAnsi).join("\n");
		expect(wide).toContain("1.2k↑ 56↓");
		expect(wide).toContain("$0.0042");

		const narrow = component.render(34).map(stripAnsi);
		expect(narrow.every((line) => visibleWidth(line) <= 34)).toBe(true);
		expect(narrow.join("\n")).not.toContain("$0.0042");
		await runtime.shutdown();
	});

	it("keeps step diagnostics on the assistant side without repeated actor headers", async () => {
		const now = Date.now();
		const userMessage = { role: "user", content: [{ type: "text", text: "Check it" }], timestamp: now - 3_000 };
		const first = assistant({ timestamp: now - 2_000 });
		const second = assistant({ timestamp: now - 1_000, content: [{ type: "text", text: "Done" }] });
		const runtime = await startRuntime([
			{ type: "message", message: userMessage, timestamp: new Date(now - 3_000).toISOString() },
			{ type: "message", message: first, timestamp: new Date(now - 1_500).toISOString() },
			{ type: "message", message: { role: "toolResult" } },
			{ type: "message", message: second, timestamp: new Date(now).toISOString() },
		]);
		const primary = new AssistantMessageComponent(first, false, getMarkdownTheme(), "Thinking...", 1)
			.render(80).map(stripAnsi);
		const continuation = new AssistantMessageComponent(second, false, getMarkdownTheme(), "Thinking...", 1)
			.render(80).map(stripAnsi);
		expect(primary.some((line) => line.includes("────"))).toBe(true);
		expect(continuation.some((line) => line.includes("────"))).toBe(false);
		expect(continuation.join("\n")).not.toContain("🤖 test-model");
		const stepLine = continuation.find((line) => line.includes("02"));
		expect(stepLine?.indexOf("02")).toBe(1);
		expect(stepLine).toContain("02  ›");
		expect(stepLine).not.toMatch(/[←→]/);
		expect(continuation.join("\n")).toContain("$0");
		expect(continuation.join("\n")).toContain("Done");
		await runtime.shutdown();
	});

	it("adds date labels when historical messages cross calendar days", async () => {
		const firstTimestamp = new Date("2025-01-01T12:00:00").getTime();
		const secondTimestamp = new Date("2025-01-02T12:00:00").getTime();
		const userMessage = { role: "user", content: [{ type: "text", text: "Before midnight" }], timestamp: firstTimestamp };
		const message = assistant({ timestamp: secondTimestamp });
		const runtime = await startRuntime([
			{ type: "message", message: userMessage, timestamp: new Date(firstTimestamp).toISOString() },
			{ type: "message", message, timestamp: new Date(secondTimestamp).toISOString() },
		]);
		const lines = new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking...", 1)
			.render(80).map(stripAnsi);
		expect(lines.some((line) => line.includes("VAULT LOG //") && line.includes("2025") && line.includes("─"))).toBe(true);
		await runtime.shutdown();
	});

	it("uses assistant completion time for live date boundaries", async () => {
		vi.useFakeTimers();
		const beforeMidnight = new Date(2025, 0, 1, 23, 59, 58);
		const afterMidnight = new Date(2025, 0, 2, 0, 0, 5);
		vi.setSystemTime(beforeMidnight);
		const runtime = await startRuntime();
		await runtime.emit("message_start", {
			message: { role: "user", content: [{ type: "text", text: "Late" }], timestamp: beforeMidnight.getTime() - 1_000 },
		});
		const start = assistant({ timestamp: beforeMidnight.getTime() });
		await runtime.emit("message_start", { message: start });
		const component = new AssistantMessageComponent(start, false, getMarkdownTheme(), "Thinking...", 1);

		vi.setSystemTime(afterMidnight);
		const final = { ...start };
		await runtime.emit("message_end", { message: final });
		component.updateContent(final);
		const lines = component.render(80).map(stripAnsi);
		expect(lines.some((line) => line.includes("VAULT LOG //") && line.includes("2025") && line.includes("─"))).toBe(true);
		await runtime.shutdown();
	});

	it("applies valid config edits live to existing message components", async () => {
		const path = setConfig({ actors: { user: "You" }, icons: { user: "👤" } });
		const runtime = await startRuntime();
		const component = new UserMessageComponent("Live", getMarkdownTheme(), 1);
		expect(component.render(80).map(stripAnsi).join("\n")).toContain("👤 You");

		writeFileSync(path, JSON.stringify({ actors: { user: "Артем" }, icons: { user: "😎" } }));
		await vi.waitFor(() => {
			expect(runtime.notify).toHaveBeenCalledWith("pi-chat-layout: configuration reloaded", "info");
		});
		expect(component.render(80).map(stripAnsi).join("\n")).toContain("😎 Артем");
		await runtime.shutdown();
	});

	it("applies live config edits to existing assistant headers", async () => {
		const path = setConfig({ actors: { assistant: { name: "", mode: "prefix" } } });
		const now = Date.now();
		const message = assistant({ timestamp: now - 1_000 });
		const runtime = await startRuntime([
			{ type: "message", message, timestamp: new Date(now).toISOString() },
		]);
		const component = new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking...", 1);
		expect(component.render(80).map(stripAnsi).join("\n")).not.toContain("Pi test-model");

		writeFileSync(path, JSON.stringify({ actors: { assistant: { name: "Pi", mode: "prefix" } } }));
		await vi.waitFor(() => {
			expect(runtime.notify).toHaveBeenCalledWith("pi-chat-layout: configuration reloaded", "info");
		});
		expect(component.render(80).map(stripAnsi).join("\n")).toContain("Pi test-model");
		await runtime.shutdown();
	});

	it("keeps the last valid config while an edited file contains invalid JSON", async () => {
		const path = setConfig({ actors: { user: "Артем" } });
		const runtime = await startRuntime();
		const component = new UserMessageComponent("Invalid", getMarkdownTheme(), 1);
		expect(component.render(80).map(stripAnsi).join("\n")).toContain("Артем");

		writeFileSync(path, "{");
		await vi.waitFor(() => {
			expect(runtime.notify).toHaveBeenCalledWith(
				expect.stringContaining("Could not load"),
				"warning",
			);
		});
		expect(component.render(80).map(stripAnsi).join("\n")).toContain("Артем");
		await runtime.shutdown();
	});

	it("uses the public extension theme for added transcript rows", async () => {
		const theme = {
			fg: (_color: string, value: string) => `\x1b[38;5;201m${value}\x1b[39m`,
			bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
		};
		const runtime = await startRuntime([], "high", theme);
		const lines = new UserMessageComponent("Theme", getMarkdownTheme(), 1).render(80);
		expect(lines.join("\n")).toContain("\x1b[38;5;201m");
		await runtime.shutdown();
	});

	it("falls back to stock rendering when the compatibility probe fails", async () => {
		const prototype = UserMessageComponent.prototype as unknown as { render(width: number): string[] };
		const originalRender = prototype.render;
		const incompatibleRender = (width: number) => ["x".repeat(width + 1)];
		prototype.render = incompatibleRender;
		let runtime: Runtime | undefined;
		try {
			runtime = await startRuntime();
			expect(runtime.notify).toHaveBeenCalledWith(
				expect.stringContaining("compatibility probe"),
				"error",
			);
			expect(prototype.render).toBe(incompatibleRender);
		} finally {
			await runtime?.shutdown();
			prototype.render = originalRender;
		}
	});
});
