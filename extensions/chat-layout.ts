import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	parseSkillBlock,
	type ThemeColor,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type MarkdownTheme,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	type AssistantNameMode,
	configPath,
	DEFAULT_CONFIG,
	type ChatLayoutConfig,
	type HeaderMetadata,
	loadConfig,
} from "../src/config.js";

interface Timing {
	completedAt: number;
	durationMs: number;
}

interface AssistantPresentation {
	kind: "primary" | "continuation";
	step: number;
	dateLabel?: string;
}

interface UserPresentation {
	sentAt: number;
	dateLabel?: string;
}

interface AssistantMessageContainer {
	contentContainer: {
		children: Component[];
	};
	markdownTheme: MarkdownTheme;
	outputPad: number;
	invalidate(): void;
}

interface UserMessageContainer {
	text: string;
	outputPad: number;
	invalidate(): void;
}

interface MarkdownComponent extends Component {
	defaultTextStyle?: {
		italic?: boolean;
	};
}

interface HeaderField {
	key: HeaderMetadata;
	text: string;
}

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type RenderTheme = ExtensionContext["ui"]["theme"];
type AssistantUpdate = (this: AssistantMessageContainer, message: AssistantMessage) => void;
type UserInvalidate = (this: UserMessageContainer) => void;
type UserRebuild = (this: UserMessageContainer) => void;
type UserRender = (this: UserMessageContainer, width: number) => string[];

const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const FIELD_DROP_PRIORITY: Record<HeaderMetadata, number> = {
	time: 0,
	duration: 1,
	thinking: 2,
	tokens: 3,
	cost: 4,
};
const USER_SENT_AT_KEY = Symbol.for("pi-chat-layout:user-sent-at");
const USER_DATE_LABEL_KEY = Symbol.for("pi-chat-layout:user-date-label");
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const ASSISTANT_MARKDOWN_THEME_KEY = Symbol.for("pi-chat-layout:assistant-markdown-theme");
const THINKING_FRAMES = [".   ", ".o  ", ".oO ", " oO ", "  O ", "    "] as const;
const THINKING_FRAME_INTERVAL_MS = 400;
const CODE_LANGUAGE_BADGES: Readonly<Record<string, string>> = {
	bash: "SH",
	css: "CSS",
	go: "GO",
	html: "HTML",
	javascript: "JS",
	js: "JS",
	jsx: "JSX",
	json: "JSON",
	markdown: "MD",
	md: "MD",
	python: "PY",
	py: "PY",
	rust: "RS",
	sh: "SH",
	shell: "SH",
	sql: "SQL",
	text: "TXT",
	tsx: "TSX",
	typescript: "TS",
	ts: "TS",
	yaml: "YAML",
	yml: "YAML",
};
const TIME_FORMATTER = new Intl.DateTimeFormat([], {
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
});
const DATE_FORMATTER = new Intl.DateTimeFormat([], {
	year: "numeric",
	month: "short",
	day: "numeric",
});
const formattedTimeCache = new Map<number, string>();
const MARKDOWN_SUBHEADING_PREFIX = /#{3,6} /;
let renderTheme: RenderTheme | undefined;

function codeLanguageBadge(language: string): string {
	const normalized = language.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
	if (!normalized) return "CODE";
	return CODE_LANGUAGE_BADGES[normalized] ?? normalized.slice(0, 6).toUpperCase();
}

function polishedMarkdownTheme(base: MarkdownTheme): MarkdownTheme {
	let codeBlockOpen = false;
	let codeBlockLabel = "";
	const highlightCode = base.highlightCode;
	return {
		...base,
		heading(text: string): string {
			return base.heading(text.replace(MARKDOWN_SUBHEADING_PREFIX, "› "));
		},
		codeBlockIndent: " ",
		highlightCode(code: string, language?: string): string[] {
			const lines = highlightCode
				? highlightCode(code, language)
				: code.split("\n").map((line) => base.codeBlock(line));
			return ["", ...lines, ""];
		},
		codeBlockBorder(text: string): string {
			if (text === "```") {
				if (!codeBlockOpen) {
					codeBlockOpen = true;
					codeBlockLabel = "CODE";
					return base.codeBlockBorder(`<<~${codeBlockLabel}`);
				}
				codeBlockOpen = false;
				return base.codeBlockBorder(codeBlockLabel);
			}
			codeBlockOpen = true;
			codeBlockLabel = codeLanguageBadge(text.slice(3));
			return base.codeBlockBorder(`<<~${codeBlockLabel}`);
		},
	};
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.has(value as ThinkingLevel);
}

function themed(color: ThemeColor, text: string): string {
	return renderTheme?.fg(color, text) ?? text;
}

function isThinkingMarkdown(component: Component): component is MarkdownComponent {
	return (component as MarkdownComponent).defaultTextStyle?.italic === true;
}

function thinkingBlock(content: Component, active: boolean, color: ThemeColor): Component {
	let cachedWidth: number | undefined;
	let cachedContentLines: string[] | undefined;
	let cachedMarker: string | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			const marker = active
				? THINKING_FRAMES[Math.floor(Date.now() / THINKING_FRAME_INTERVAL_MS) % THINKING_FRAMES.length]
				: ".oO ";
			const markerText = `${marker} `;
			const markerWidth = visibleWidth(markerText);
			if (width <= markerWidth) return content.render(width);
			if (cachedWidth !== width || cachedContentLines === undefined) {
				cachedWidth = width;
				cachedContentLines = content.render(width - markerWidth);
				cachedLines = undefined;
			}
			if (cachedMarker === marker && cachedLines !== undefined) return cachedLines;
			const prefix = themed(color, markerText);
			const continuation = " ".repeat(markerWidth);
			cachedMarker = marker;
			let paragraphStart = true;
			cachedLines = cachedContentLines.map((line) => {
				const blank = line.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
				if (blank) {
					paragraphStart = true;
					return continuation + line;
				}
				if (!paragraphStart) return continuation + line;
				paragraphStart = false;
				if (line.startsWith(" ")) return ` ${prefix}${line.slice(1)}`;
				const styledPadding = line.match(/^((?:\x1b\[[0-9;]*m)+) /);
				if (styledPadding !== null) {
					return ` ${prefix}${styledPadding[1]}${line.slice(styledPadding[0].length)}`;
				}
				return prefix + line;
			});
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
			cachedContentLines = undefined;
			cachedMarker = undefined;
			cachedLines = undefined;
			content.invalidate();
		},
	};
}

function bold(text: string): string {
	return renderTheme?.bold(text) ?? `\x1b[1m${text}\x1b[22m`;
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

function formatDate(timestamp: number): string {
	return DATE_FORMATTER.format(timestamp);
}

function calendarDay(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) return `${durationMs}ms`;
	const seconds = durationMs / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = Math.round(seconds - minutes * 60);
	return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
}

function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}m`;
}

function formatTokens(message: AssistantMessage): string {
	return `${formatTokenCount(message.usage.input)}↑ ${formatTokenCount(message.usage.output)}↓`;
}

function formatCost(cost: number): string {
	if (cost === 0) return "$0";
	if (cost < 0.0001) return "<$0.0001";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

function thinkingColor(level: ThinkingLevel): ThemeColor {
	return `thinking${level[0].toUpperCase()}${level.slice(1)}` as ThemeColor;
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

function fitHeader(label: string, fields: HeaderField[], width: number, separator: string): string {
	const visibleFields = [...fields];
	const render = () => [label, ...visibleFields.map((field) => field.text)].join(`  ${separator}  `);

	while (visibleFields.length > 0 && visibleWidth(render()) > width) {
		let dropIndex = 0;
		for (let index = 1; index < visibleFields.length; index += 1) {
			if (FIELD_DROP_PRIORITY[visibleFields[index].key] > FIELD_DROP_PRIORITY[visibleFields[dropIndex].key]) {
				dropIndex = index;
			}
		}
		visibleFields.splice(dropIndex, 1);
	}
	return truncateToWidth(render(), width);
}

function actorHeader(actor: string, fields: HeaderField[], width: number): string {
	return fitHeader(bold(themed("accent", actor)), fields, width, themed("dim", "×"));
}

function stepHeader(step: number, fields: HeaderField[], width: number): string {
	return fitHeader(
		themed("dim", `step ${step}`),
		fields.filter((field) => field.key !== "thinking"),
		width,
		themed("dim", "›"),
	);
}

function messageDivider(width: number, dateLabel?: string): string[] {
	if (!dateLabel) return ["", themed("dim", "─".repeat(Math.max(0, width))), ""];
	const label = ` ${dateLabel} `;
	if (visibleWidth(label) >= width) return ["", themed("dim", truncateToWidth(label, width)), ""];
	const remaining = width - visibleWidth(label);
	const left = Math.floor(remaining / 2);
	const right = remaining - left;
	return ["", themed("dim", `${"─".repeat(left)}${label}${"─".repeat(right)}`), ""];
}

function iconLabel(icon: string, label: string): string {
	return [icon, label].filter(Boolean).join(" ");
}

function assistantActor(model: string, name: string, mode: AssistantNameMode): string {
	if (!name) return model;
	return mode === "replace" ? name : `${name} ${model}`;
}

function assistantFields(
	message: AssistantMessage,
	timing: Timing | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	metadata: HeaderMetadata[],
): HeaderField[] {
	const completedAt = timing?.completedAt ?? message.timestamp;
	const fields: HeaderField[] = [];
	for (const item of metadata) {
		switch (item) {
			case "thinking":
				if (thinkingLevel !== undefined) {
					fields.push({ key: item, text: themed(thinkingColor(thinkingLevel), thinkingLevel) });
				}
				break;
			case "time":
				fields.push({ key: item, text: themed("dim", formatTime(completedAt)) });
				break;
			case "duration":
				if (timing !== undefined) {
					fields.push({ key: item, text: themed("dim", formatDuration(timing.durationMs)) });
				}
				break;
			case "tokens":
				if (timing !== undefined) {
					fields.push({ key: item, text: themed("dim", formatTokens(message)) });
				}
				break;
			case "cost":
				if (timing !== undefined) {
					fields.push({ key: item, text: themed("dim", formatCost(message.usage.cost.total)) });
				}
				break;
		}
	}
	return fields;
}

function assistantHeader(
	message: AssistantMessage,
	timing: Timing | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	presentation: AssistantPresentation | undefined,
	padding: number,
	getConfig: () => ChatLayoutConfig,
	getEpoch: () => number,
): Component {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	let cachedEpoch: number | undefined;
	return {
		render(width: number): string[] {
			const epoch = getEpoch();
			if (cachedWidth === width && cachedEpoch === epoch && cachedLines !== undefined) return cachedLines;
			const config = getConfig();
			const horizontalPadding = Math.min(padding, Math.max(0, Math.floor((width - 1) / 2)));
			const contentWidth = Math.max(1, width - horizontalPadding * 2);
			const fields = assistantFields(message, timing, thinkingLevel, config.header.metadata);
			const continuation = presentation?.kind === "continuation" && !presentation.dateLabel;
			let header: string;
			let insetHeader: string;
			if (continuation) {
				header = stepHeader(presentation.step, fields, contentWidth);
				insetHeader = `${" ".repeat(horizontalPadding)}${header}`;
			} else {
				const actor = iconLabel(
					config.icons.assistant,
					assistantActor(
						message.model,
						config.actors.assistant.name,
						config.actors.assistant.mode,
					),
				);
				header = actorHeader(actor, fields, contentWidth);
				insetHeader = `${" ".repeat(horizontalPadding)}${header}`;
			}
			cachedWidth = width;
			cachedEpoch = epoch;
			cachedLines = continuation
				? ["", insetHeader]
				: [...messageDivider(width, presentation?.dateLabel), insetHeader];
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
			cachedEpoch = undefined;
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

function sameConfig(left: ChatLayoutConfig, right: ChatLayoutConfig): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export default function (pi: ExtensionAPI) {
	let config: ChatLayoutConfig = structuredClone(DEFAULT_CONFIG);
	let timingByMessage = new WeakMap<AssistantMessage, Timing>();
	let thinkingByMessage = new WeakMap<AssistantMessage, ThinkingLevel>();
	let presentationByMessage = new WeakMap<AssistantMessage, AssistantPresentation>();
	let activeAssistantMessages = new WeakSet<AssistantMessage>();
	let activeAssistantThinkingLevel: ThinkingLevel | undefined;
	let activeAssistantPresentation: AssistantPresentation | undefined;
	let userRenderCache = new WeakMap<UserMessageContainer, { epoch: number; width: number; lines: string[] }>();
	let pendingUserPresentations = new Map<string, UserPresentation[]>();
	let nextAssistantStep = 1;
	let lastMessageDay: string | undefined;
	let restoreLayout: (() => void) | undefined;
	let renderEpoch = 0;
	let configWatcher: FSWatcher | undefined;
	let configReloadTimer: NodeJS.Timeout | undefined;
	let lastConfigWarning: string | undefined;

	function dateLabelFor(timestamp: unknown, includeFirst: boolean): string | undefined {
		const parsedTimestamp = parseTimestamp(timestamp);
		if (parsedTimestamp === undefined) return undefined;
		const day = calendarDay(parsedTimestamp);
		const changed = lastMessageDay !== undefined && day !== lastMessageDay;
		const first = includeFirst && lastMessageDay === undefined;
		lastMessageDay = day;
		return changed || first ? formatDate(parsedTimestamp) : undefined;
	}

	function queueUserPresentation(text: string, timestamp: unknown, includeFirstDate = false): void {
		const renderedText = parseSkillBlock(text)?.userMessage ?? text;
		const sentAt = parseTimestamp(timestamp);
		if (!renderedText || sentAt === undefined) return;
		const queue = pendingUserPresentations.get(renderedText) ?? [];
		queue.push({ sentAt, dateLabel: dateLabelFor(sentAt, includeFirstDate) });
		pendingUserPresentations.set(renderedText, queue);
	}

	function resolveUserPresentation(component: UserMessageContainer): UserPresentation {
		const state = component as unknown as Record<PropertyKey, unknown>;
		const persistedTimestamp = parseTimestamp(state[USER_SENT_AT_KEY]);
		if (persistedTimestamp !== undefined) {
			const persistedDate = state[USER_DATE_LABEL_KEY];
			return {
				sentAt: persistedTimestamp,
				dateLabel: typeof persistedDate === "string" ? persistedDate : undefined,
			};
		}

		const queue = pendingUserPresentations.get(component.text);
		const presentation = queue?.shift() ?? { sentAt: Date.now() };
		if (queue?.length === 0) pendingUserPresentations.delete(component.text);
		state[USER_SENT_AT_KEY] = presentation.sentAt;
		state[USER_DATE_LABEL_KEY] = presentation.dateLabel ?? null;
		return presentation;
	}

	function rememberHistoricalState(ctx: ExtensionContext): void {
		timingByMessage = new WeakMap<AssistantMessage, Timing>();
		thinkingByMessage = new WeakMap<AssistantMessage, ThinkingLevel>();
		presentationByMessage = new WeakMap<AssistantMessage, AssistantPresentation>();
		activeAssistantMessages = new WeakSet<AssistantMessage>();
		activeAssistantThinkingLevel = undefined;
		activeAssistantPresentation = undefined;
		userRenderCache = new WeakMap<UserMessageContainer, { epoch: number; width: number; lines: string[] }>();
		pendingUserPresentations = new Map<string, UserPresentation[]>();
		nextAssistantStep = 1;
		lastMessageDay = undefined;
		let thinkingLevel: ThinkingLevel | undefined;
		let includeFirstDate = true;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "thinking_level_change") {
				thinkingLevel = isThinkingLevel(entry.thinkingLevel) ? entry.thinkingLevel : undefined;
				continue;
			}
			if (entry.type !== "message") continue;
			if (entry.message.role === "user") {
				queueUserPresentation(userMessageText(entry.message), entry.message.timestamp, includeFirstDate);
				includeFirstDate = false;
				nextAssistantStep = 1;
				continue;
			}
			if (entry.message.role !== "assistant") continue;

			const completedAt = parseTimestamp(entry.timestamp);
			const startedAt = parseTimestamp(entry.message.timestamp);
			const displayedAt = completedAt ?? startedAt;
			presentationByMessage.set(entry.message, {
				kind: nextAssistantStep === 1 ? "primary" : "continuation",
				step: nextAssistantStep,
				dateLabel: dateLabelFor(displayedAt, includeFirstDate),
			});
			includeFirstDate = false;
			nextAssistantStep += 1;
			if (thinkingLevel !== undefined) thinkingByMessage.set(entry.message, thinkingLevel);
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
		const probeText = "chat-layout-probe";
		const probe = new UserMessageComponent(probeText, getMarkdownTheme(), 1) as unknown as UserMessageContainer;
		const probeLines = originalUserRender.call(probe, 80);
		if (
			probe.text !== probeText ||
			probe.outputPad !== 1 ||
			!probeLines.some((line) => line.includes(probeText)) ||
			probeLines.some((line) => visibleWidth(line) > 80)
		) {
			throw new Error("This Pi version failed the message renderer compatibility probe.");
		}

		const decoratedAssistantUpdate: AssistantUpdate = function (message) {
			const state = this as unknown as Record<PropertyKey, unknown>;
			let markdownTheme = state[ASSISTANT_MARKDOWN_THEME_KEY] as MarkdownTheme | undefined;
			if (markdownTheme === undefined) {
				markdownTheme = polishedMarkdownTheme(this.markdownTheme);
				state[ASSISTANT_MARKDOWN_THEME_KEY] = markdownTheme;
			}
			this.markdownTheme = markdownTheme;
			originalAssistantUpdate.call(this, message);
			if (!this.contentContainer || !Array.isArray(this.contentContainer.children)) return;
			const thinkingActive = activeAssistantMessages.has(message);
			for (let index = 0; index < this.contentContainer.children.length; index += 1) {
				const child = this.contentContainer.children[index];
				if (isThinkingMarkdown(child)) {
					this.contentContainer.children[index] = thinkingBlock(child, thinkingActive, "dim");
				}
			}
			const presentation = presentationByMessage.get(message);
			this.contentContainer.children.unshift(
				assistantHeader(
					message,
					timingByMessage.get(message),
					thinkingByMessage.get(message),
					presentation,
					this.outputPad,
					() => config,
					() => renderEpoch,
				),
			);
		};

		const decoratedUserInvalidate: UserInvalidate = function () {
			userRenderCache.delete(this);
			originalUserInvalidate.call(this);
		};

		const decoratedUserRebuild: UserRebuild = function () {
			userRenderCache.delete(this);
			if (typeof this.text === "string") resolveUserPresentation(this);
			originalUserRebuild.call(this);
		};

		const decoratedUserRender: UserRender = function (width) {
			if (typeof this.text !== "string" || typeof this.outputPad !== "number") {
				return originalUserRender.call(this, width);
			}
			const cached = userRenderCache.get(this);
			if (cached?.width === width && cached.epoch === renderEpoch) return cached.lines;
			const presentation = resolveUserPresentation(this);
			const userActor = iconLabel(config.icons.user, config.actors.user);
			const timeField: HeaderField = { key: "time", text: themed("dim", formatTime(presentation.sentAt)) };
			const naturalHeader = actorHeader(userActor, [timeField], width);
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
			const headerContent = actorHeader(userActor, [timeField], headerWidth);
			const headerIndent = alternating
				? Math.max(0, width - bubbleWidth + this.outputPad)
				: this.outputPad;
			const header = `${" ".repeat(headerIndent)}${headerContent}`;
			const lines = [...messageDivider(width, presentation.dateLabel), header, ...bubbleLines];
			userRenderCache.set(this, { epoch: renderEpoch, width, lines });
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

	function stopConfigWatcher(): void {
		if (configReloadTimer) clearTimeout(configReloadTimer);
		configReloadTimer = undefined;
		configWatcher?.close();
		configWatcher = undefined;
	}

	function startConfigWatcher(ctx: ExtensionContext): void {
		stopConfigWatcher();
		const path = configPath();
		const watchedFile = basename(path);
		const reload = () => {
			configReloadTimer = undefined;
			const loaded = loadConfig(path, config);
			if (loaded.warning && loaded.warning !== lastConfigWarning) {
				ctx.ui.notify(`pi-chat-layout: ${loaded.warning}`, "warning");
			}
			lastConfigWarning = loaded.warning;
			if (sameConfig(config, loaded.config)) return;
			config = loaded.config;
			renderEpoch += 1;
			ctx.ui.notify("pi-chat-layout: configuration reloaded", "info");
		};
		const scheduleReload = () => {
			if (configReloadTimer) clearTimeout(configReloadTimer);
			configReloadTimer = setTimeout(reload, 100);
		};

		try {
			configWatcher = watch(dirname(path), (_eventType, filename) => {
				if (filename !== null && filename.toString() !== watchedFile) return;
				scheduleReload();
			});
			configWatcher.on("error", (error) => {
				stopConfigWatcher();
				ctx.ui.notify(`pi-chat-layout: config watcher stopped: ${error.message}`, "warning");
			});
		} catch (error) {
			ctx.ui.notify(
				`pi-chat-layout: could not watch ${path}: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		renderTheme = ctx.ui.theme;
		const loaded = loadConfig();
		config = loaded.config;
		lastConfigWarning = loaded.warning;
		if (loaded.warning) ctx.ui.notify(`pi-chat-layout: ${loaded.warning}`, "warning");
		rememberHistoricalState(ctx);
		try {
			decorateChatLayout();
			startConfigWatcher(ctx);
		} catch (error) {
			ctx.ui.notify(
				`pi-chat-layout: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "user") {
			queueUserPresentation(userMessageText(event.message), event.message.timestamp);
			nextAssistantStep = 1;
			return;
		}
		if (event.message.role !== "assistant") return;
		activeAssistantMessages.add(event.message);
		activeAssistantThinkingLevel = pi.getThinkingLevel();
		activeAssistantPresentation = {
			kind: nextAssistantStep === 1 ? "primary" : "continuation",
			step: nextAssistantStep,
		};
		nextAssistantStep += 1;
		thinkingByMessage.set(event.message, activeAssistantThinkingLevel);
		presentationByMessage.set(event.message, activeAssistantPresentation);
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		activeAssistantMessages.add(event.message);
		if (activeAssistantThinkingLevel !== undefined) {
			thinkingByMessage.set(event.message, activeAssistantThinkingLevel);
		}
		if (activeAssistantPresentation !== undefined) {
			presentationByMessage.set(event.message, activeAssistantPresentation);
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		activeAssistantMessages.delete(event.message);
		const thinkingLevel = activeAssistantThinkingLevel ?? pi.getThinkingLevel();
		thinkingByMessage.set(event.message, thinkingLevel);
		const completedAt = Date.now();
		const startedAt = parseTimestamp(event.message.timestamp) ?? completedAt;
		if (activeAssistantPresentation !== undefined) {
			activeAssistantPresentation.dateLabel = dateLabelFor(completedAt, false);
			presentationByMessage.set(event.message, activeAssistantPresentation);
		}
		activeAssistantThinkingLevel = undefined;
		activeAssistantPresentation = undefined;
		timingByMessage.set(event.message, {
			completedAt,
			durationMs: Math.max(0, completedAt - startedAt),
		});
	});

	pi.on("session_shutdown", () => {
		stopConfigWatcher();
		restoreLayout?.();
		renderTheme = undefined;
	});
}
