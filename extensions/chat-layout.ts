import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	parseSkillBlock,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, type ChatLayoutConfig, loadConfig } from "../src/config.js";

interface Timing {
	completedAt: number;
	durationMs: number;
}

interface ActiveTheme {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface AssistantMessageContainer {
	contentContainer: {
		children: Component[];
	};
	outputPad: number;
}

interface UserMessageContainer {
	text: string;
	outputPad: number;
}

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.has(value as ThinkingLevel);
}

type AssistantUpdate = (this: AssistantMessageContainer, message: AssistantMessage) => void;
type UserInvalidate = (this: UserMessageContainer) => void;
type UserRebuild = (this: UserMessageContainer) => void;
type UserRender = (this: UserMessageContainer, width: number) => string[];

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const USER_SENT_AT_KEY = Symbol.for("pi-chat-layout:user-sent-at");
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const TIME_FORMATTER = new Intl.DateTimeFormat([], {
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
});
const formattedTimeCache = new Map<number, string>();

function activeTheme(): ActiveTheme | undefined {
	return (globalThis as Record<PropertyKey, unknown>)[THEME_KEY] as ActiveTheme | undefined;
}

function themed(color: string, text: string): string {
	return activeTheme()?.fg(color, text) ?? text;
}

function bold(text: string): string {
	return activeTheme()?.bold(text) ?? `\x1b[1m${text}\x1b[22m`;
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (value instanceof Date) {
		const timestamp = value.getTime();
		return Number.isFinite(timestamp) ? timestamp : undefined;
	}
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function formatTime(timestamp: unknown): string {
	const parsed = parseTimestamp(timestamp);
	if (parsed === undefined) return "--:--:--";
	const cached = formattedTimeCache.get(parsed);
	if (cached !== undefined) return cached;
	const formatted = TIME_FORMATTER.format(parsed);
	formattedTimeCache.set(parsed, formatted);
	return formatted;
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${durationMs}ms`;

	const seconds = durationMs / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;

	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = Math.round(seconds - minutes * 60);
	return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
}

function prefixAfterShellMarker(line: string, prefix: string): string {
	if (line.startsWith(OSC133_ZONE_START)) {
		return OSC133_ZONE_START + prefix + line.slice(OSC133_ZONE_START.length);
	}
	return prefix + line;
}

function rightAlign(line: string, width: number): string {
	const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
	return prefixAfterShellMarker(line, padding);
}

function actorHeader(
	actor: string,
	timestamp: unknown,
	width: number,
	durationMs?: number,
	thinkingLevel?: ThinkingLevel,
): string {
	const separator = themed("dim", "◆");
	const actorLabel = bold(themed("accent", actor));
	const thinking = thinkingLevel === undefined
		? ""
		: `  ${separator}  ${themed(`thinking${thinkingLevel[0].toUpperCase()}${thinkingLevel.slice(1)}`, thinkingLevel)}`;
	const timeLabel = themed("dim", formatTime(timestamp));
	const duration = durationMs === undefined
		? ""
		: `  ${separator}  ${themed("dim", formatDuration(durationMs))}`;
	return truncateToWidth(`${actorLabel}${thinking}  ${separator}  ${timeLabel}${duration}`, width);
}

function messageDivider(width: number): string[] {
	return ["", themed("dim", "─".repeat(Math.max(0, width))), ""];
}

function assistantHeader(
	message: AssistantMessage,
	timing: Timing | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	padding: number,
	assistantIcon: string,
): Component {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			if (cachedWidth === width && cachedLines !== undefined) return cachedLines;
			const horizontalPadding = Math.min(padding, Math.max(0, Math.floor((width - 1) / 2)));
			const contentWidth = Math.max(1, width - horizontalPadding * 2);
			const completedAt = timing?.completedAt ?? message.timestamp;
			const actor = assistantIcon ? `${assistantIcon} ${message.model}` : message.model;
			const header = actorHeader(
				actor,
				completedAt,
				contentWidth,
				timing?.durationMs,
				thinkingLevel,
			);
			const insetHeader = `${" ".repeat(horizontalPadding)}${header}`;
			cachedWidth = width;
			cachedLines = [...messageDivider(width), insetHeader];
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
	};
}

function userMessageText(message: { content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => {
			return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
		})
		.map((block) => block.text)
		.join("");
}

export default function (pi: ExtensionAPI) {
	let config: ChatLayoutConfig = structuredClone(DEFAULT_CONFIG);
	let timingByMessage = new WeakMap<AssistantMessage, Timing>();
	let thinkingByMessage = new WeakMap<AssistantMessage, ThinkingLevel>();
	let activeAssistantThinkingLevel: ThinkingLevel | undefined;
	let userRenderCache = new WeakMap<UserMessageContainer, { width: number; lines: string[] }>();
	let pendingUserTimes = new Map<string, number[]>();
	let restoreLayout: (() => void) | undefined;

	function queueUserTime(text: string, timestamp: unknown): void {
		const renderedText = parseSkillBlock(text)?.userMessage ?? text;
		const parsedTimestamp = parseTimestamp(timestamp);
		if (!renderedText || parsedTimestamp === undefined) return;
		const queue = pendingUserTimes.get(renderedText) ?? [];
		queue.push(parsedTimestamp);
		pendingUserTimes.set(renderedText, queue);
	}

	function resolveUserSentAt(component: UserMessageContainer): number {
		const state = component as unknown as Record<PropertyKey, unknown>;
		const persistedTimestamp = parseTimestamp(state[USER_SENT_AT_KEY]);
		if (persistedTimestamp !== undefined) return persistedTimestamp;

		const queue = pendingUserTimes.get(component.text);
		const sentAt = queue?.shift() ?? Date.now();
		if (queue?.length === 0) pendingUserTimes.delete(component.text);
		state[USER_SENT_AT_KEY] = sentAt;
		return sentAt;
	}

	function rememberHistoricalTimings(ctx: ExtensionContext): void {
		timingByMessage = new WeakMap<AssistantMessage, Timing>();
		thinkingByMessage = new WeakMap<AssistantMessage, ThinkingLevel>();
		activeAssistantThinkingLevel = undefined;
		userRenderCache = new WeakMap<UserMessageContainer, { width: number; lines: string[] }>();
		pendingUserTimes = new Map<string, number[]>();
		let thinkingLevel: ThinkingLevel | undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "thinking_level_change") {
				thinkingLevel = isThinkingLevel(entry.thinkingLevel) ? entry.thinkingLevel : undefined;
				continue;
			}
			if (entry.type !== "message") continue;
			if (entry.message.role === "user") {
				queueUserTime(userMessageText(entry.message), entry.message.timestamp);
				continue;
			}
			if (entry.message.role !== "assistant") continue;
			if (thinkingLevel !== undefined) thinkingByMessage.set(entry.message, thinkingLevel);

			const completedAt = parseTimestamp(entry.timestamp);
			const startedAt = parseTimestamp(entry.message.timestamp);
			if (completedAt === undefined || startedAt === undefined) continue;

			timingByMessage.set(entry.message, {
				completedAt,
				durationMs: Math.max(0, completedAt - startedAt),
			});
		}
	}

	function decorateChatLayout(): void {
		if (restoreLayout) return;

		const assistantPrototype = AssistantMessageComponent.prototype as unknown as {
			updateContent: AssistantUpdate;
		};
		const userPrototype = UserMessageComponent.prototype as unknown as {
			invalidate: UserInvalidate;
			rebuild: UserRebuild;
			render: UserRender;
		};
		if (
			typeof assistantPrototype.updateContent !== "function" ||
			typeof userPrototype.invalidate !== "function" ||
			typeof userPrototype.rebuild !== "function" ||
			typeof userPrototype.render !== "function"
		) {
			throw new Error("This Pi version has incompatible message components.");
		}

		const originalAssistantUpdate = assistantPrototype.updateContent;
		const originalUserInvalidate = userPrototype.invalidate;
		const originalUserRebuild = userPrototype.rebuild;
		const originalUserRender = userPrototype.render;

		const decoratedAssistantUpdate: AssistantUpdate = function (message) {
			originalAssistantUpdate.call(this, message);
			if (!this.contentContainer || !Array.isArray(this.contentContainer.children)) return;
			this.contentContainer.children.unshift(
				assistantHeader(
					message,
					timingByMessage.get(message),
					thinkingByMessage.get(message),
					this.outputPad,
					config.icons.assistant,
				),
			);
		};

		const decoratedUserInvalidate: UserInvalidate = function () {
			userRenderCache.delete(this);
			originalUserInvalidate.call(this);
		};

		const decoratedUserRebuild: UserRebuild = function () {
			userRenderCache.delete(this);
			if (typeof this.text === "string") resolveUserSentAt(this);
			originalUserRebuild.call(this);
		};

		const decoratedUserRender: UserRender = function (width) {
			if (typeof this.text !== "string" || typeof this.outputPad !== "number") {
				return originalUserRender.call(this, width);
			}
			const cached = userRenderCache.get(this);
			if (cached?.width === width) return cached.lines;
			const sentAt = resolveUserSentAt(this);
			const userActor = config.icons.user ? `${config.icons.user} You` : "You";
			const naturalHeader = actorHeader(userActor, sentAt, width);
			const maxBubbleWidth = Math.max(1, Math.min(88, Math.floor(width * 0.78)));
			const longestLine = Math.max(1, ...this.text.split("\n").map((line) => visibleWidth(line)));
			const desiredWidth = Math.max(
				12,
				longestLine + this.outputPad * 2,
				visibleWidth(naturalHeader) + this.outputPad * 2,
			);
			const bubbleWidth = Math.min(width, maxBubbleWidth, desiredWidth);
			const rawBubbleLines = originalUserRender.call(this, bubbleWidth);
			if (rawBubbleLines.length > 1) {
				const bottomPadding = rawBubbleLines.pop();
				const endMarker = OSC133_ZONE_END + OSC133_ZONE_FINAL;
				if (bottomPadding?.startsWith(endMarker)) {
					rawBubbleLines[rawBubbleLines.length - 1] =
						endMarker + rawBubbleLines[rawBubbleLines.length - 1];
				}
			}
			const alternating = config.layout === "alternating";
			const bubbleLines = alternating
				? rawBubbleLines.map((line) => rightAlign(line, width))
				: rawBubbleLines;
			const headerWidth = Math.max(1, bubbleWidth - this.outputPad * 2);
			const headerContent = actorHeader(userActor, sentAt, headerWidth);
			const headerIndent = alternating
				? Math.max(0, width - bubbleWidth + this.outputPad)
				: this.outputPad;
			const header = `${" ".repeat(headerIndent)}${headerContent}`;
			const lines = [...messageDivider(width), header, ...bubbleLines];
			userRenderCache.set(this, { width, lines });
			return lines;
		};

		assistantPrototype.updateContent = decoratedAssistantUpdate;
		userPrototype.invalidate = decoratedUserInvalidate;
		userPrototype.rebuild = decoratedUserRebuild;
		userPrototype.render = decoratedUserRender;

		restoreLayout = () => {
			if (assistantPrototype.updateContent === decoratedAssistantUpdate) {
				assistantPrototype.updateContent = originalAssistantUpdate;
			}
			if (userPrototype.invalidate === decoratedUserInvalidate) {
				userPrototype.invalidate = originalUserInvalidate;
			}
			if (userPrototype.rebuild === decoratedUserRebuild) {
				userPrototype.rebuild = originalUserRebuild;
			}
			if (userPrototype.render === decoratedUserRender) {
				userPrototype.render = originalUserRender;
			}
			restoreLayout = undefined;
		};
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const loaded = loadConfig();
		config = loaded.config;
		if (loaded.warning) ctx.ui.notify(`pi-chat-layout: ${loaded.warning}`, "warning");
		rememberHistoricalTimings(ctx);
		try {
			decorateChatLayout();
		} catch (error) {
			ctx.ui.notify(
				`pi-chat-layout: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "user") {
			queueUserTime(userMessageText(event.message), event.message.timestamp);
		} else if (event.message.role === "assistant") {
			activeAssistantThinkingLevel = pi.getThinkingLevel();
			thinkingByMessage.set(event.message, activeAssistantThinkingLevel);
		}
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant" || activeAssistantThinkingLevel === undefined) return;
		thinkingByMessage.set(event.message, activeAssistantThinkingLevel);
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;

		const thinkingLevel = activeAssistantThinkingLevel ?? pi.getThinkingLevel();
		thinkingByMessage.set(event.message, thinkingLevel);
		activeAssistantThinkingLevel = undefined;
		const completedAt = Date.now();
		const startedAt = parseTimestamp(event.message.timestamp) ?? completedAt;
		timingByMessage.set(event.message, {
			completedAt,
			durationMs: Math.max(0, completedAt - startedAt),
		});
	});

	pi.on("session_shutdown", () => {
		restoreLayout?.();
	});
}
