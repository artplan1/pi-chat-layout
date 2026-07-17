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

		expect(userLines.find((line) => line.includes("ME Artem"))?.startsWith(" ")).toBe(true);
		expect(assistantLines).toContainEqual(expect.stringContaining("AI Pi test-model  ×  high"));
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
		expect(rendered).toContain("╭─ TS");
		expect(rendered).toContain("│ const value = 42;");
		expect(rendered).toContain("╭─ TXT");
		expect(rendered).toContain("╭─ CODE");
		expect(rendered.match(/╰─/g)).toHaveLength(3);
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		await runtime.shutdown();
	});

	it("animates active thinking on Pi's render cadence without styling normal italics", async () => {
		const runtime = await startRuntime();
		const completed = assistant({
			content: [
				{ type: "thinking", thinking: "Inspecting renderer behavior\n\nEvaluating alternatives" },
				{ type: "text", text: "*Done*" },
			],
		});
		const completedComponent = new AssistantMessageComponent(completed, false, getMarkdownTheme(), "Thinking...", 1);
		const completedLines = completedComponent.render(32).map(stripAnsi);
		const thinkingLine = completedLines.find((line) => line.includes("Inspecting"));
		const textLine = completedLines.find((line) => line.includes("Done"));
		expect(thinkingLine).toMatch(/^ \.oO  Inspecting/);
		expect(completedLines.join("\n").match(/\.oO/g)).toHaveLength(2);
		expect(textLine).not.toContain(".oO");
		expect(completedLines.every((line) => visibleWidth(line) <= 32)).toBe(true);
		expect(completedComponent.render(32)).toEqual(completedComponent.render(32));

		const active = assistant({ content: [{ type: "thinking", thinking: "Still working" }] });
		await runtime.emit("message_start", { message: active });
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const activeComponent = new AssistantMessageComponent(active, false, getMarkdownTheme(), "Thinking...", 1);
		expect(activeComponent.render(32).map(stripAnsi).join("\n")).toContain("\n .    Still working");
		vi.setSystemTime(400);
		expect(activeComponent.render(32).map(stripAnsi).join("\n")).toContain("\n .o   Still working");
		vi.setSystemTime(2_000);
		expect(activeComponent.render(32).map(stripAnsi).join("\n")).toContain("\n      Still working");
		vi.useRealTimers();
		await runtime.emit("message_end", { message: active });
		activeComponent.updateContent(active);
		expect(activeComponent.render(32).map(stripAnsi).join("\n")).toContain("\n .oO  Still working");
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
		expect(lines).toContainEqual(expect.stringContaining("🤖 Pi  ×"));
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
		const runtime = await startRuntime([], "xhigh");
		const start = assistant({ content: [{ type: "text", text: "A" }] });
		await runtime.emit("message_start", { message: { ...start } });
		const component = new AssistantMessageComponent(start, false, getMarkdownTheme(), "Thinking...", 1);

		const update = { ...start, content: [{ type: "text" as const, text: "AB" }] };
		await runtime.emit("message_update", { message: update });
		component.updateContent(update);
		expect(component.render(80).map(stripAnsi).join("\n")).toContain("×  xhigh  ×");
		expect(component.render(80).map(stripAnsi).join("\n")).not.toContain("0↑ 0↓");
		expect(component.render(80).map(stripAnsi).join("\n")).not.toContain("$0");

		const final = { ...update };
		await runtime.emit("message_end", { message: final });
		component.updateContent(final);
		expect(component.render(80).map(stripAnsi).join("\n")).toContain("×  xhigh  ×");
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
		expect(continuation.some((line) => line.includes("×"))).toBe(false);
		const stepLine = continuation.find((line) => line.includes("step 2"));
		expect(stepLine?.indexOf("step 2")).toBe(1);
		expect(stepLine).toContain("step 2  ›");
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
		expect(lines.some((line) => line.includes("2025") && line.includes("─"))).toBe(true);
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
		expect(lines.some((line) => line.includes("2025") && line.includes("─"))).toBe(true);
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
