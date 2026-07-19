import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
	it("uses neutral defaults", () => {
		expect(parseConfig(undefined)).toEqual({ config: DEFAULT_CONFIG });
		expect(DEFAULT_CONFIG.models.aliases).toEqual({});
		expect(DEFAULT_CONFIG.dates.label).toBe("{date}");
		expect(DEFAULT_CONFIG.thinking.markerGlyphs).toBeUndefined();
	});

	it("accepts icons, exact model aliases, header style, and date labels", () => {
		expect(parseConfig({
			layout: "stacked",
			icons: { user: "ME", assistant: "AI", thinking: { medium: "THINK" } },
			actors: { user: "Artem", assistant: { name: "Pi", mode: "replace" } },
			models: { aliases: { "provider/model": "MODEL" } },
			thinking: { markerGlyphs: ["a", "界"] },
			header: { metadata: ["thinking", "time", "duration", "cost", "time"], style: "compact" },
			dates: { label: "LOG // {date}" },
		})).toEqual({
			config: {
				layout: "stacked",
				icons: { user: "ME", assistant: "AI", thinking: { medium: "THINK" } },
				actors: { user: "Artem", assistant: { name: "Pi", mode: "replace" } },
				models: { aliases: { "provider/model": "MODEL" } },
				thinking: { markerGlyphs: ["a", "界"] },
				header: { metadata: ["thinking", "time", "duration", "cost"], style: "compact" },
				dates: { label: "LOG // {date}" },
			},
			warning: undefined,
		});
	});

	it("preserves the supported assistant icon", () => {
		expect(parseConfig({ icons: { assistant: "AI" } }).config.icons.assistant).toBe("AI");
	});

	it("falls back to portable markers when the glyph pool is malformed", () => {
		for (const markerGlyphs of [42, [], ["a", ""]]) {
			const result = parseConfig({ thinking: { markerGlyphs } });
			expect(result.config.thinking).toEqual(DEFAULT_CONFIG.thinking);
			expect(result.warning).toContain('"thinking.markerGlyphs"');
		}
	});

	it("falls back per field and reports invalid values", () => {
		const result = parseConfig({
			layout: "diagonal",
			icons: { user: 42, assistant: 42, thinking: { high: 42 } },
			actors: { user: false, assistant: { name: 42, mode: "suffix" } },
			models: { aliases: { "": "empty", valid: 42 } },
			thinking: { markerGlyphs: "not-an-array" },
			header: { metadata: ["latency"], style: "wide" },
			dates: { label: 42 },
		});
		expect(result.config).toEqual(DEFAULT_CONFIG);
		expect(result.warning).toContain('"layout"');
		expect(result.warning).toContain('"icons.user"');
		expect(result.warning).toContain('"icons.assistant"');
		expect(result.warning).toContain('"icons.thinking.high"');
		expect(result.warning).toContain('"actors.user"');
		expect(result.warning).toContain('"actors.assistant.name"');
		expect(result.warning).toContain('"actors.assistant.mode"');
		expect(result.warning).toContain('"models.aliases" cannot contain');
		expect(result.warning).toContain('"models.aliases.valid"');
		expect(result.warning).toContain("Unknown header metadata");
		expect(result.warning).toContain('"header.style"');
		expect(result.warning).toContain('"dates.label"');
		expect(result.warning).toContain('"thinking.markerGlyphs"');
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
