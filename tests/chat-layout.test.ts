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
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import chatLayout from "../extensions/chat-layout.js";

interface Runtime {
	emit(name: string, event?: unknown): Promise<void>;
	shutdown(): Promise<void>;
}

const createdDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => initTheme("dark"));

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

function setConfig(config: unknown): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-chat-layout-"));
	createdDirs.push(dir);
	writeFileSync(join(dir, "chat-layout.json"), JSON.stringify(config));
	process.env.PI_CODING_AGENT_DIR = dir;
}

async function startRuntime(entries: unknown[] = [], thinking = "high"): Promise<Runtime> {
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

	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => entries },
		ui: { notify: vi.fn() },
	};
	const emit = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	await emit("session_start");
	return { emit, shutdown: () => emit("session_shutdown") };
}

describe.sequential("chat layout renderer", () => {
	it("alternates user and assistant alignment with configured icons", async () => {
		setConfig({ layout: "alternating", icons: { user: "ME", assistant: "AI" } });
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

		expect(userLines.find((line) => line.includes("ME You"))?.startsWith(" ")).toBe(true);
		expect(assistantLines).toContainEqual(expect.stringContaining("AI test-model  ◆  high"));
		expect([...userLines, ...assistantLines].every((line) => visibleWidth(line) <= 80)).toBe(true);
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
		expect(component.render(80).map(stripAnsi).join("\n")).toContain("◆  xhigh  ◆");

		const final = { ...update };
		await runtime.emit("message_end", { message: final });
		component.updateContent(final);
		expect(component.render(80).map(stripAnsi).join("\n")).toContain("◆  xhigh  ◆");
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
});
