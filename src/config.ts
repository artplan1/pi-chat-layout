import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ChatLayout = "stacked" | "alternating";
export type AssistantNameMode = "prefix" | "replace";
export type HeaderMetadata = "thinking" | "time" | "duration" | "tokens" | "cost";

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
	};
	actors: {
		user: string;
		assistant: {
			name: string;
			mode: AssistantNameMode;
		};
	};
	header: {
		metadata: HeaderMetadata[];
	};
}

export const DEFAULT_CONFIG: ChatLayoutConfig = {
	layout: "alternating",
	icons: {
		user: "👤",
		assistant: "🤖",
	},
	actors: {
		user: "You",
		assistant: {
			name: "",
			mode: "prefix",
		},
	},
	header: {
		metadata: ["thinking", "time", "duration", "tokens", "cost"],
	},
};

export interface LoadedConfig {
	config: ChatLayoutConfig;
	warning?: string;
}

export function parseConfig(value: unknown): LoadedConfig {
	if (value === undefined) return { config: structuredClone(DEFAULT_CONFIG) };
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { config: structuredClone(DEFAULT_CONFIG), warning: "Configuration must be a JSON object." };
	}

	const input = value as Record<string, unknown>;
	const warnings: string[] = [];
	let layout = DEFAULT_CONFIG.layout;
	if (input.layout !== undefined) {
		if (input.layout === "stacked" || input.layout === "alternating") layout = input.layout;
		else warnings.push('"layout" must be "stacked" or "alternating".');
	}

	const icons = { ...DEFAULT_CONFIG.icons };
	if (input.icons !== undefined) {
		if (typeof input.icons !== "object" || input.icons === null || Array.isArray(input.icons)) {
			warnings.push('"icons" must be an object.');
		} else {
			const iconInput = input.icons as Record<string, unknown>;
			for (const actor of ["user", "assistant"] as const) {
				if (iconInput[actor] === undefined) continue;
				if (typeof iconInput[actor] === "string") icons[actor] = iconInput[actor];
				else warnings.push(`"icons.${actor}" must be a string.`);
			}
		}
	}

	const actors = structuredClone(DEFAULT_CONFIG.actors);
	if (input.actors !== undefined) {
		if (typeof input.actors !== "object" || input.actors === null || Array.isArray(input.actors)) {
			warnings.push('"actors" must be an object.');
		} else {
			const actorInput = input.actors as Record<string, unknown>;
			if (actorInput.user !== undefined) {
				if (typeof actorInput.user === "string") actors.user = actorInput.user;
				else warnings.push('"actors.user" must be a string.');
			}
			if (actorInput.assistant !== undefined) {
				if (
					typeof actorInput.assistant !== "object" ||
					actorInput.assistant === null ||
					Array.isArray(actorInput.assistant)
				) {
					warnings.push('"actors.assistant" must be an object.');
				} else {
					const assistantInput = actorInput.assistant as Record<string, unknown>;
					if (assistantInput.name !== undefined) {
						if (typeof assistantInput.name === "string") actors.assistant.name = assistantInput.name;
						else warnings.push('"actors.assistant.name" must be a string.');
					}
					if (assistantInput.mode !== undefined) {
						if (assistantInput.mode === "prefix" || assistantInput.mode === "replace") {
							actors.assistant.mode = assistantInput.mode;
						} else {
							warnings.push('"actors.assistant.mode" must be "prefix" or "replace".');
						}
					}
				}
			}
		}
	}

	let metadata = [...DEFAULT_CONFIG.header.metadata];
	if (input.header !== undefined) {
		if (typeof input.header !== "object" || input.header === null || Array.isArray(input.header)) {
			warnings.push('"header" must be an object.');
		} else {
			const headerInput = input.header as Record<string, unknown>;
			if (headerInput.metadata !== undefined) {
				if (!Array.isArray(headerInput.metadata)) {
					warnings.push('"header.metadata" must be an array.');
				} else {
					const nextMetadata: HeaderMetadata[] = [];
					for (const value of headerInput.metadata) {
						if (typeof value !== "string" || !HEADER_METADATA.has(value as HeaderMetadata)) {
							warnings.push(`Unknown header metadata: ${JSON.stringify(value)}.`);
							continue;
						}
						const item = value as HeaderMetadata;
						if (!nextMetadata.includes(item)) nextMetadata.push(item);
					}
					if (headerInput.metadata.length === 0 || nextMetadata.length > 0) metadata = nextMetadata;
				}
			}
		}
	}

	return {
		config: { layout, icons, actors, header: { metadata } },
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
