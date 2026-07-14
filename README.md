# pi-chat-layout

Messenger-style conversation layout for the [Pi coding agent](https://github.com/earendil-works/pi).

It makes long terminal sessions easier to scan by adding actor headers, timestamps, response duration, thinking level, dividers, configurable icons, and optional alternating alignment.

```text

────────────────────────────────────────────────────────────

                                      👤 You  ◆  21:03:30

                                      Continue the refactor


────────────────────────────────────────────────────────────

 🤖 gpt-5.6-sol  ◆  high  ◆  21:03:35  ◆  4.0s

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
  }
}
```

`PI_CODING_AGENT_DIR` is respected when Pi uses a custom configuration directory.

### Layouts

- `alternating` — assistant messages stay left-aligned and user messages move to the right, like a messenger app.
- `stacked` — both actors stay left-aligned, like a conventional transcript.

### Icons

Icons are arbitrary strings. Use an empty string to hide an icon:

```json
{
  "icons": {
    "user": "",
    "assistant": "AI"
  }
}
```

Run `/reload` after changing configuration.

## Displayed metadata

Assistant headers show:

- actual model ID;
- thinking level active when the response started;
- completion time;
- total response duration.

User headers show the message submission time. Historical metadata is reconstructed from Pi session entries and is not written back to the session or sent to the model.

`Ctrl+O` continues to control Pi tool-call expansion. It does not expand chat-layout headers.

## Performance

Rendered headers and timestamps are cached. In a benchmark using a 126-message session, steady-state render overhead was within measurement noise. The extension adds transcript rows for dividers, headers, and spacing, so terminal scrollback is intentionally taller.

## Compatibility

Tested with Pi `0.80.6`.

Pi currently has no public renderer hook for built-in user and assistant messages. This extension decorates the exported `UserMessageComponent` and `AssistantMessageComponent` at runtime. A future Pi release may require a compatibility update.

## Development

```bash
npm install
npm run check
npm run pack:dry
```

Regression coverage includes:

- historical timestamps;
- runtime reloads;
- streaming assistant-message clones;
- thinking-level persistence;
- terminal width constraints;
- OSC shell markers;
- vertical spacing;
- stacked and alternating layouts.

## License

MIT
