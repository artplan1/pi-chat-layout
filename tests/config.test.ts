import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
	it("uses messenger-style defaults", () => {
		expect(parseConfig(undefined)).toEqual({ config: DEFAULT_CONFIG });
	});

	it("accepts layout, icon, actor name, and header metadata overrides", () => {
		expect(parseConfig({
			layout: "stacked",
			icons: { user: "ME", assistant: "AI" },
			actors: {
				user: "Artem",
				assistant: { name: "Pi", mode: "replace" },
			},
			header: { metadata: ["time", "duration", "cost", "time"] },
		})).toEqual({
			config: {
				layout: "stacked",
				icons: { user: "ME", assistant: "AI" },
				actors: {
					user: "Artem",
					assistant: { name: "Pi", mode: "replace" },
				},
				header: { metadata: ["time", "duration", "cost"] },
			},
			warning: undefined,
		});
	});

	it("falls back per field and reports invalid values", () => {
		const result = parseConfig({
			layout: "diagonal",
			icons: { user: 42 },
			actors: { user: false, assistant: { name: 42, mode: "suffix" } },
			header: { metadata: ["latency"] },
		});
		expect(result.config).toEqual(DEFAULT_CONFIG);
		expect(result.warning).toContain('"layout"');
		expect(result.warning).toContain('"icons.user"');
		expect(result.warning).toContain('"actors.user"');
		expect(result.warning).toContain('"actors.assistant.name"');
		expect(result.warning).toContain('"actors.assistant.mode"');
		expect(result.warning).toContain("Unknown header metadata");
	});

	it("allows all assistant metadata to be hidden", () => {
		expect(parseConfig({ header: { metadata: [] } }).config.header.metadata).toEqual([]);
	});

	it("keeps the provided fallback when a watched config file is temporarily missing", () => {
		const fallback = structuredClone(DEFAULT_CONFIG);
		fallback.actors.user = "Артем";
		expect(loadConfig(`/missing-chat-layout-${Date.now()}.json`, fallback)).toEqual({ config: fallback });
	});
});
