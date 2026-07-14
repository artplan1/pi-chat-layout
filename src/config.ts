import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ChatLayout = "stacked" | "alternating";

export interface ChatLayoutConfig {
	layout: ChatLayout;
	icons: {
		user: string;
		assistant: string;
	};
}

export const DEFAULT_CONFIG: ChatLayoutConfig = {
	layout: "alternating",
	icons: {
		user: "👤",
		assistant: "🤖",
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

	return {
		config: { layout, icons },
		warning: warnings.length > 0 ? warnings.join(" ") : undefined,
	};
}

export function configPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "chat-layout.json");
}

export function loadConfig(path = configPath()): LoadedConfig {
	try {
		return parseConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig(undefined);
		return {
			config: structuredClone(DEFAULT_CONFIG),
			warning: `Could not load ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
