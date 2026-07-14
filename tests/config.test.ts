import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
	it("uses messenger-style defaults", () => {
		expect(parseConfig(undefined)).toEqual({ config: DEFAULT_CONFIG });
	});

	it("accepts layout and actor icon overrides", () => {
		expect(parseConfig({
			layout: "stacked",
			icons: { user: "ME", assistant: "AI" },
		})).toEqual({
			config: {
				layout: "stacked",
				icons: { user: "ME", assistant: "AI" },
			},
			warning: undefined,
		});
	});

	it("falls back per field and reports invalid values", () => {
		const result = parseConfig({ layout: "diagonal", icons: { user: 42 } });
		expect(result.config).toEqual(DEFAULT_CONFIG);
		expect(result.warning).toContain('"layout"');
		expect(result.warning).toContain('"icons.user"');
	});
});
