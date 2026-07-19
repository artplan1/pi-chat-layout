# pi-chat-layout

[![npm version](https://badgen.net/npm/v/pi-chat-layout)](https://www.npmjs.com/package/pi-chat-layout)
[![npm downloads](https://badgen.net/npm/dm/pi-chat-layout)](https://www.npmjs.com/package/pi-chat-layout)
[![license](https://badgen.net/github/license/artplan1/pi-chat-layout)](LICENSE)

A messenger-style conversation layout for the [Pi coding agent](https://github.com/earendil-works/pi). It adds actor headers, responsive metadata, turn grouping, date separators, and optional alternating alignment without imposing a model or terminal-font theme.

| Light | Dark |
|:---:|:---:|
| ![Light terminal theme](docs/images/chat-layout-light.png) | ![Dark terminal theme](docs/images/chat-layout-dark.png) |

## Install

```bash
pi install npm:pi-chat-layout
```

Use `pi -e npm:pi-chat-layout` for one run. Remove it with `pi remove npm:pi-chat-layout`.

## Configuration

The extension works without configuration. For the icons and spacing shown in the screenshots, use [IosevkaTerm Nerd Font Mono](https://github.com/ryanoasis/nerd-fonts/tree/master/patched-fonts/IosevkaTerm).

Then create `~/.pi/agent/chat-layout.json`:

```json
{
  "icons": {
    "user": "😎",
    "assistant": "",
    "thinking": { "medium": "󱩒", "high": "󱩔" }
  },
  "models": {
    "aliases": { "openai-codex/gpt-5.6-sol": "SOL" }
  },
  "thinking": {
    "markerGlyphs": ["ｱ", "ｲ", "ｳ", "ｴ", "ｵ", "ｶ", "ｷ", "ｸ"]
  },
  "header": { "style": "compact" },
  "dates": { "label": "VAULT LOG // {date}" }
}
```

Every field is optional. Defaults use alternating alignment, `👤 You`, `🤖 <provider/model>`, separate lower-case thinking metadata, portable ASCII activity markers, and a plain date label.

### Options

- `layout`: `alternating` (default) or `stacked`.
- `icons.user`, `icons.assistant`, and `icons.thinking.<level>`: arbitrary strings; use `""` to hide an icon.
- `actors.user`: user label. `actors.assistant.name` can `prefix` or `replace` the model ID.
- `models.aliases`: exact `provider/model` matches. Unknown models keep their actual ID.
- `header.metadata`: any ordered subset of `thinking`, `time`, `duration`, `tokens`, and `cost`.
- `header.style`: `separate` (default) or `compact`, which combines the thinking icon, identity, and upper-case level.
- `thinking.markerGlyphs`: non-empty array used to build deterministic four-glyph activity markers. Mixed-width entries share a stable column.
- `dates.label`: replaces `{date}` with the localized date; use `""` for an unlabeled divider.

Configuration changes hot-reload. `PI_CODING_AGENT_DIR` is respected. Invalid JSON keeps the last valid configuration; invalid fields fall back individually and produce a warning. On narrow terminals, low-priority metadata is removed before the header is truncated.

## Behavior and compatibility

User headers show submission time. Assistant headers show available thinking, timing, token, and cost metadata. Follow-up assistant steps keep compact diagnostics without repeating the actor header.

Pi does not yet expose a public renderer hook for built-in messages, so the extension decorates its message components. A startup compatibility probe preserves stock rendering when those internals are incompatible. Core Pi packages remain host-provided peer dependencies.

## Development

```bash
pnpm install
pnpm check
pnpm pack:dry
```

## License

MIT
