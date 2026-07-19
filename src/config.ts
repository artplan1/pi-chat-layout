import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ChatLayout = "stacked" | "alternating";
export type AssistantNameMode = "prefix" | "replace";
export type AssistantHeaderStyle = "separate" | "compact";
export type HeaderMetadata = "thinking" | "time" | "duration" | "tokens" | "cost";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

const HEADER_METADATA = new Set<HeaderMetadata>([
	"thinking",
	"time",
	"duration",
	"tokens",
	"cost",
]);

export interface ChatLayoutConfig {
	layout: ChatLayout;
	icons: {
		user: string;
		assistant: string;
		thinking: Partial<Record<ThinkingLevelName, string>>;
	};
	actors: {
		user: string;
		assistant: {
			name: string;
			mode: AssistantNameMode;
		};
	};
	models: {
		aliases: Record<string, string>;
	};
	thinking: {
		markerGlyphs?: string[];
	};
	header: {
		metadata: HeaderMetadata[];
		style: AssistantHeaderStyle;
	};
	dates: {
		label: string;
	};
}

export const DEFAULT_CONFIG: ChatLayoutConfig = {
	layout: "alternating",
	icons: {
		user: "👤",
		assistant: "🤖",
		thinking: {},
	},
	actors: {
		user: "You",
		assistant: {
			name: "",
			mode: "prefix",
		},
	},
	models: {
		aliases: {},
	},
	thinking: { markerGlyphs: undefined },
	header: {
		metadata: ["thinking", "time", "duration", "tokens", "cost"],
		style: "separate",
	},
	dates: {
		label: "{date}",
	},
};

export interface LoadedConfig {
	config: ChatLayoutConfig;
	warning?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfig(value: unknown): LoadedConfig {
	if (value === undefined) return { config: structuredClone(DEFAULT_CONFIG) };
	if (!isObject(value)) {
		return { config: structuredClone(DEFAULT_CONFIG), warning: "Configuration must be a JSON object." };
	}

	const input = value;
	const warnings: string[] = [];
	let layout = DEFAULT_CONFIG.layout;
	if (input.layout !== undefined) {
		if (input.layout === "stacked" || input.layout === "alternating") layout = input.layout;
		else warnings.push('"layout" must be "stacked" or "alternating".');
	}

	const icons = structuredClone(DEFAULT_CONFIG.icons);
	if (input.icons !== undefined) {
		if (!isObject(input.icons)) {
			warnings.push('"icons" must be an object.');
		} else {
			for (const actor of ["user", "assistant"] as const) {
				if (input.icons[actor] === undefined) continue;
				if (typeof input.icons[actor] === "string") icons[actor] = input.icons[actor];
				else warnings.push(`"icons.${actor}" must be a string.`);
			}
			if (input.icons.thinking !== undefined) {
				if (!isObject(input.icons.thinking)) {
					warnings.push('"icons.thinking" must be an object.');
				} else {
					for (const level of THINKING_LEVELS) {
						const icon = input.icons.thinking[level];
						if (icon === undefined) continue;
						if (typeof icon === "string") icons.thinking[level] = icon;
						else warnings.push(`"icons.thinking.${level}" must be a string.`);
					}
				}
			}
		}
	}

	const actors = structuredClone(DEFAULT_CONFIG.actors);
	if (input.actors !== undefined) {
		if (!isObject(input.actors)) {
			warnings.push('"actors" must be an object.');
		} else {
			if (input.actors.user !== undefined) {
				if (typeof input.actors.user === "string") actors.user = input.actors.user;
				else warnings.push('"actors.user" must be a string.');
			}
			if (input.actors.assistant !== undefined) {
				if (!isObject(input.actors.assistant)) {
					warnings.push('"actors.assistant" must be an object.');
				} else {
					if (input.actors.assistant.name !== undefined) {
						if (typeof input.actors.assistant.name === "string") {
							actors.assistant.name = input.actors.assistant.name;
						} else warnings.push('"actors.assistant.name" must be a string.');
					}
					if (input.actors.assistant.mode !== undefined) {
						if (input.actors.assistant.mode === "prefix" || input.actors.assistant.mode === "replace") {
							actors.assistant.mode = input.actors.assistant.mode;
						} else warnings.push('"actors.assistant.mode" must be "prefix" or "replace".');
					}
				}
			}
		}
	}

	const aliases: Record<string, string> = {};
	if (input.models !== undefined) {
		if (!isObject(input.models)) {
			warnings.push('"models" must be an object.');
		} else if (input.models.aliases !== undefined) {
			if (!isObject(input.models.aliases)) {
				warnings.push('"models.aliases" must be an object.');
			} else {
				for (const [model, alias] of Object.entries(input.models.aliases)) {
					if (model.trim() === "") warnings.push('"models.aliases" cannot contain an empty model ID.');
					else if (typeof alias === "string") aliases[model] = alias;
					else warnings.push(`"models.aliases.${model}" must be a string.`);
				}
			}
		}
	}

	let markerGlyphs = DEFAULT_CONFIG.thinking.markerGlyphs;
	if (input.thinking !== undefined) {
		if (!isObject(input.thinking)) {
			warnings.push('"thinking" must be an object.');
		} else if (input.thinking.markerGlyphs !== undefined) {
			if (!Array.isArray(input.thinking.markerGlyphs) || input.thinking.markerGlyphs.length === 0) {
				warnings.push('"thinking.markerGlyphs" must be a non-empty array of visible strings.');
			} else {
				const validGlyphs = input.thinking.markerGlyphs.filter(
					(glyph): glyph is string => typeof glyph === "string" && glyph.trim() !== "",
				);
				if (validGlyphs.length === input.thinking.markerGlyphs.length) markerGlyphs = validGlyphs;
				else warnings.push('"thinking.markerGlyphs" must contain only non-empty visible strings.');
			}
		}
	}

	let metadata = [...DEFAULT_CONFIG.header.metadata];
	let style = DEFAULT_CONFIG.header.style;
	if (input.header !== undefined) {
		if (!isObject(input.header)) {
			warnings.push('"header" must be an object.');
		} else {
			if (input.header.metadata !== undefined) {
				if (!Array.isArray(input.header.metadata)) {
					warnings.push('"header.metadata" must be an array.');
				} else {
					const nextMetadata: HeaderMetadata[] = [];
					for (const value of input.header.metadata) {
						if (typeof value !== "string" || !HEADER_METADATA.has(value as HeaderMetadata)) {
							warnings.push(`Unknown header metadata: ${JSON.stringify(value)}.`);
							continue;
						}
						const item = value as HeaderMetadata;
						if (!nextMetadata.includes(item)) nextMetadata.push(item);
					}
					if (input.header.metadata.length === 0 || nextMetadata.length > 0) metadata = nextMetadata;
				}
			}
			if (input.header.style !== undefined) {
				if (input.header.style === "separate" || input.header.style === "compact") style = input.header.style;
				else warnings.push('"header.style" must be "separate" or "compact".');
			}
		}
	}

	let dateLabel = DEFAULT_CONFIG.dates.label;
	if (input.dates !== undefined) {
		if (!isObject(input.dates)) warnings.push('"dates" must be an object.');
		else if (input.dates.label !== undefined) {
			if (typeof input.dates.label === "string") dateLabel = input.dates.label;
			else warnings.push('"dates.label" must be a string.');
		}
	}

	return {
		config: {
			layout,
			icons,
			actors,
			models: { aliases },
			thinking: { markerGlyphs },
			header: { metadata, style },
			dates: { label: dateLabel },
		},
		warning: warnings.length > 0 ? warnings.join(" ") : undefined,
	};
}

export function configPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "chat-layout.json");
}

export function loadConfig(
	path = configPath(),
	fallback: ChatLayoutConfig = DEFAULT_CONFIG,
): LoadedConfig {
	try {
		return parseConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { config: structuredClone(fallback) };
		}
		return {
			config: structuredClone(fallback),
			warning: `Could not load ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
