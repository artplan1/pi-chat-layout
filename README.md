# pi-chat-layout

Messenger-style conversation layout for the [Pi coding agent](https://github.com/earendil-works/pi).

It makes long terminal sessions easier to scan with actor headers, responsive metadata, turn grouping, date separators, configurable names and icons, and optional alternating alignment.

```text

────────────────────────────────────────────────────────────

                                      👤 You  ×  21:03:30

                                      Continue the refactor


────────────────────────────────────────────────────────────

 🤖 gpt-5.6-sol  ×  high  ×  21:03:35  ×  4.0s  ×  1.2k↑ 340↓  ×  $0.0041

 Done. The tests pass.
```

## Install

From npm:

```bash
pi install npm:pi-chat-layout
```

From GitHub:

```bash
pi install git:github.com/artplan1/pi-chat-layout
```

Try it for one run:

```bash
pi -e npm:pi-chat-layout
```

## Configuration

Create `~/.pi/agent/chat-layout.json`:

```json
{
  "layout": "alternating",
  "icons": {
    "user": "👤",
    "assistant": "🤖"
  },
  "actors": {
    "user": "You",
    "assistant": {
      "name": "Pi",
      "mode": "prefix"
    }
  },
  "header": {
    "metadata": ["thinking", "time", "duration", "tokens", "cost"]
  }
}
```

`PI_CODING_AGENT_DIR` is respected when Pi uses a custom configuration directory.

### Layouts

- `alternating` — assistant messages stay left-aligned and user messages move to the right, like a messenger app.
- `stacked` — both actors stay left-aligned, like a conventional transcript.

### Actor names

Set `actors.user` to the user label. Assistant labels can either prefix or replace the actual model ID:

```json
{
  "actors": {
    "user": "Artem",
    "assistant": {
      "name": "Pi",
      "mode": "prefix"
    }
  }
}
```

- `prefix` renders `Pi gpt-5.6-sol`.
- `replace` renders `Pi` and hides the model ID.
- An empty assistant name preserves the model ID regardless of mode.

### Header metadata

`header.metadata` controls assistant metadata and its display order. Supported values are `thinking`, `time`, `duration`, `tokens`, and `cost`. Use an empty array to show only the actor label.

On narrow terminals, low-priority fields are removed before the header is truncated. Cost and token counts disappear first; the completion time is retained longest.

### Icons

Actor icons are arbitrary strings. Use an empty string to hide one:

```json
{
  "icons": {
    "user": "",
    "assistant": "AI"
  }
}
```

`icons.thinking` optionally maps individual reasoning levels to icons. Omitted levels keep their text label without an icon. This Nerd Fonts example uses the Material Design lightbulb intensity family; configure a Nerd Font or `Symbols Nerd Font Mono` fallback in the terminal:

```json
{
  "icons": {
    "thinking": {
      "off": "\udb83\ude50",
      "minimal": "\udb86\ude4e",
      "low": "\udb86\ude50",
      "medium": "\udb86\ude52",
      "high": "\udb86\ude54",
      "xhigh": "\udb86\ude56",
      "max": "\udb81\udee8"
    }
  }
}
```

Configuration changes are watched and applied automatically. Invalid JSON keeps the last valid configuration active and shows a warning.

## Displayed metadata

Assistant headers can show:

- configured actor name and actual model ID;
- thinking level active when the response started;
- completion time and response duration;
- input/output token counts;
- reported request cost.

Later assistant steps omit repeated dividers and actor labels, but keep a compact diagnostic line on the assistant side, such as `step 2 › 21:03:42 › 1.6s › 1.6k↑ 26↓ › $0.01`. While a step is running, its start time remains visible; duration, tokens, and cost appear when it completes. Historical sessions receive `VAULT LOG // <date>` separators when the calendar day changes.

User headers show the message submission time. Historical metadata is reconstructed from Pi session entries and is not written back to the session or sent to the model.

`Ctrl+O` continues to control Pi tool-call expansion. It does not expand chat-layout headers.

## Performance

Rendered headers and formatted timestamps are cached by terminal width and configuration revision. Exchange grouping removes repeated transcript rows in tool-heavy exchanges.

## Compatibility

Tested with Pi `0.80.9`; peer dependencies accept compatible `0.80.x` releases from `0.80.6`.

Pi currently has no public renderer hook for built-in user and assistant messages. This extension decorates the exported `UserMessageComponent` and `AssistantMessageComponent` at runtime. A startup capability probe disables the decoration and preserves stock rendering when those internals are incompatible.

## Development

```bash
pnpm install
pnpm check
pnpm pack:dry
```

Regression coverage includes:

- historical timestamps and date boundaries;
- live configuration reloads;
- streaming assistant-message clones;
- thinking-level persistence;
- responsive metadata and terminal width constraints;
- token and cost formatting;
- assistant continuation grouping;
- public theme integration;
- compatibility probing;
- OSC shell markers and vertical spacing;
- actor name prefix and replacement modes;
- stacked and alternating layouts.

## License

MIT
