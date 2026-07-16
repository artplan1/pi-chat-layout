# pi-chat-layout — feature research

Research-only report. No product code changed. Evidence is drawn from the repository itself and
from the installed Pi primary sources at
`/Users/artem/.local/share/mise/installs/node/22.22.3/lib/node_modules/@earendil-works/pi-coding-agent/`
(version **0.80.9**; the extension declares compatibility with 0.80.6). Paths below are relative to
that directory unless prefixed with the repo root.

---

## 1. Current state and screenshot assessment

### What the extension is today

A single decorator (`extensions/chat-layout.ts`, 439 lines) plus a config loader (`src/config.ts`).
It patches four methods on two Pi-internal prototypes — `AssistantMessageComponent.updateContent`,
and `UserMessageComponent.invalidate` / `rebuild` / `render` — to prepend a divider and an actor
header, and to right-align user bubbles in `alternating` mode. Historical metadata is reconstructed
from `ctx.sessionManager.getBranch()`; live metadata comes from `message_start` / `message_update` /
`message_end`.

The engineering is careful in the places that usually break: OSC 133 markers are preserved
(`prefixAfterShellMarker`, and the `OSC133_ZONE_END + OSC133_ZONE_FINAL` re-attachment in
`decoratedUserRender`), widths go through `visibleWidth` / `truncateToWidth` rather than
`String.length`, thinking level is tracked per streaming clone via a `WeakMap`, and `restoreLayout`
makes reloads idempotent. That quality bar is the main asset to protect — every idea below is judged
against whether it keeps that bar.

### Screenshot observations

The screenshot (`pi-clipboard-2a95fcb1…png`, a live session at 23:39–23:40) is the strongest
available evidence, because it captures the user *fighting the extension's own configuration*:

1. **Configuration/version feedback is the visible friction.** The assistant says
   *"Готово: в `~/.pi/agent/chat-layout.json` агенту установлена иконка 🤡, имя пользователя — Артем.
   Применится после `/reload`."* — and the very next user message is
   *"че то имя не поменялось, выстави юзеру иконку 😎"*. In this run, the harness was still loading
   the installed pre-change package, so the new `actors` schema was not active; `/reload` alone could
   not make that unsupported field work. Separately, the updated extension reads config only during
   `session_start` (`chat-layout.ts:392-406`), so even supported edits require a reload. The product
   opportunity is to expose both the resolved config and extension capability/version, then apply
   supported edits live instead of leaving users to distinguish a stale package from stale config.
2. **Two assistant headers 3 seconds apart, split by tool calls.** `23:40:29 ◆ 5.6s` then
   `23:40:32 ◆ 3.9s`, with `read ~/.pi/agent/chat-layout.json` and `read ~/.pi/agent/settings.json`
   between them. One logical turn ("check my config") renders as two full-width dividers, two
   headers, and two duration stamps. The divider is doing turn-separation work but fires per
   *message*, not per *turn*. This is where the transcript gets noisy, and it gets worse the more
   tool calls a turn makes.
3. **Icons are already being personalized in anger.** 🤡 for the assistant, 😎 for the user — within
   one minute of use. Icon/name config is a well-chosen feature; it needs clearer capability feedback
   and should apply without a restart once the installed extension supports the field.
4. **Emoji are double-width and it holds up.** `🤡 gpt-5.6-sol` and the right-aligned `😎 You` both
   land correctly, which confirms `visibleWidth` is doing its job on wide graphemes.
5. **Timestamps carry no date.** Everything reads `23:39:46` / `23:40:23`. This session is minutes
   from midnight — a resumed session, or one that crosses 00:00, gives no way to tell "3 minutes ago"
   from "yesterday".
6. **The terminal is split.** A narrow neighbouring pane is visible at the left edge (fragments `u`,
   `y`, `…`). The chat pane here is wide, but the user demonstrably runs Pi in split panes, so
   narrow-width behaviour is a real case, not a theoretical one.
7. **No cost or token information anywhere**, although `message.usage.cost.total` is already sitting
   on every `AssistantMessage` the extension handles.

### The structural risk, stated plainly

`UserMessageComponent.rebuild` is declared **`private`** in
`dist/modes/interactive/components/user-message.d.ts`, and `invalidate` is not declared on
`UserMessageComponent` at all — it is inherited from `Container`. The extension patches both. There
is no public renderer hook for built-in user/assistant messages: `registerMessageRenderer` and
`registerEntryRenderer` are typed as
`MessageRenderer<T> = (message: CustomMessage<T>, …)` and `EntryRenderer<T> = (entry: CustomEntry<T>, …)`
(`dist/core/extensions/types.d.ts:822-823`) — **custom** types only, keyed by the extension's own
`customType` (`docs/extensions.md:1552-1558`). The README is accurate on this point.

And these components do churn. From `CHANGELOG.md`:

- `0.80.3` — *"Added an `outputPad` setting for user message, assistant message, and thinking
  horizontal padding"* (#6168) — the extension reads `this.outputPad` directly.
- *"Fixed interactive user message rendering to keep bottom padding visible in terminals affected by
  OSC 133 prompt markers without adding an extra blank line before the following assistant message"*
  (#3090) — precisely the padding/OSC interaction `decoratedUserRender` hand-patches.
- *"Fixed user-message turn spacing … by restoring an inter-message spacer before user turns"*, and
  *"Fixed first user messages rendering without spacing after existing notices"* (#3613).

Three separate upstream fixes in the exact seam this extension occupies. Treat the patch surface as
a liability to shrink, not a foundation to build on.

---

## 2. Ranked shortlist

Ranking is by (user value × evidence) ÷ (complexity + fragility added). "Public API" means it works
through documented `pi.*` / `ctx.*` surface; "patch" means it deepens dependence on private
internals.

---

### 1. Live config reload — no `/reload` round-trip

**Value.** The screenshot is a configuration-feedback bug report: the installed package did not yet
support the new `actors` field, while supported config edits also require a full runtime reload. A
resolved-config command plus live reload removes both ambiguities and benefits every config feature.

**UX/config sketch.** Watch the config file; re-read, re-validate, drop caches, repaint. Add a
`/chat-layout` command as the explicit, discoverable path.

```
/chat-layout            → shows resolved config + path, reloads it now
/chat-layout reload     → same, explicit
```

Editing `~/.pi/agent/chat-layout.json` applies on save; on a parse error the previous good config is
kept and `ctx.ui.notify(…, "warning")` explains why — never fall back to defaults mid-session, which
would silently wipe the user's icons.

**Feasibility — public API, no new patching.** `pi.registerCommand(name, { description, handler })`
is documented at `docs/extensions.md:1266+` and demonstrated in `examples/extensions/commands.ts`.
File watching via `node:fs.watch` is used by first-party example
`examples/extensions/file-trigger.ts:20`. The invalidation path already exists: `config` is a
closure variable read at render time, and both caches are keyed per component
(`userRenderCache`, plus `cachedWidth`/`cachedLines` in `assistantHeader`). The one real subtlety is
that `assistantHeader` closes over config values **at construction time**
(`chat-layout.ts:302-316`), so already-built assistant headers need rebuilding, not just cache
invalidation — read `config` lazily inside `render()` instead, and a repaint suffices.

**Complexity/risk.** Low–medium. Watcher lifecycle must be torn down in `session_shutdown` next to
`restoreLayout?.()`, or reloads leak watchers. Use a debounce and prefer watching the directory over
the file (editors replace inodes on save, which silently kills a file watch).

**Sources.** `docs/extensions.md:1266-1300`; `examples/extensions/file-trigger.ts`;
repo `extensions/chat-layout.ts:392-406`.

---

### 2. Delete the global-symbol theme hack; use `ctx.ui.theme`

**Value.** Subtractive. Removes an undocumented global-registry dependency, and picks up live theme
switching for free.

**Current code.**

```ts
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
function activeTheme() { return globalThis[THEME_KEY] as ActiveTheme | undefined; }
```

`chat-layout.ts:63,76-86` reaches into `globalThis` through a `Symbol.for` key and hand-rolls a
`\x1b[1m…\x1b[22m` fallback for when it misses.

**This is public API.** `ExtensionUIContext` declares `readonly theme: Theme`
(`dist/core/extensions/types.d.ts:173-174`), documented at `docs/extensions.md:2570`
(`ctx.ui.theme.fg("accent", "styled text")`) and used throughout first-party examples
(`examples/extensions/status-line.ts:16`). The same interface also exposes `getAllThemes()`,
`getTheme(name)`, and `setTheme(theme)` (`types.d.ts:175-187`).

**Sketch.** Capture `ctx.ui.theme` in `session_start` into the existing module-level slot; keep the
`?? text` fallbacks so unit tests that render components without a session still pass. Bonus: an
extension can react to theme changes rather than reading a global that may go stale.

**Complexity/risk.** Low, and it *reduces* risk. Caveat: rendering happens outside the handler, so
the theme reference must be stored, and cached header lines must be dropped if the theme changes —
otherwise ANSI from the old theme sticks. Tests currently call `initTheme("dark")`
(`tests/chat-layout.test.ts:24`) and construct components directly, so the fallback path must stay.

**Sources.** `dist/core/extensions/types.d.ts:173-187`; `docs/extensions.md:2489-2573`;
`examples/extensions/status-line.ts`.

---

### 3. Turn-aware grouping — one divider per turn, not per message

**Value.** Directly addresses screenshot observation #2. A tool-heavy turn currently produces N
dividers, N headers, and N duration stamps for what the user experiences as one exchange. This is
the highest-leverage *visual* change and it is subtractive — it removes rows rather than adding a
toggle.

**UX sketch.** Full divider + full header on the first assistant message of a turn. Continuation
messages within the same turn get either nothing, or a minimal continuation marker:

```
────────────────────────────────────────────────────────────

 🤖 gpt-5.6-sol  ◆  medium  ◆  23:40:29  ◆  5.6s
 Inspecting extension package and config versions
   read ~/.pi/agent/chat-layout.json
   read ~/.pi/agent/settings.json
 ·  23:40:32  ◆  3.9s          ← continuation, no divider, no re-stated actor
```

Optionally roll the turn's total duration and cost into the *last* segment's header, which is the
one the eye lands on.

**Feasibility — public API for the signal, existing patch for the paint.** `pi.on("turn_start", …)`
and `pi.on("turn_end", …)` are documented events (`ExtensionAPI` in `types.d.ts:864-865`; example
`examples/extensions/status-line.ts` uses both). The extension can mark the first assistant message
of each turn in a `WeakMap`, keyed the same way `timingByMessage` already is, and have
`decoratedAssistantUpdate` consult it.

**Complexity/risk.** Medium — the genuine difficulty is **historical reconstruction**.
`rememberHistoricalTimings` walks `ctx.sessionManager.getBranch()`, which yields `message` and
`thinking_level_change` entries; turn boundaries must be *inferred* on resume (a user message starts
a turn; consecutive assistant messages continue it) rather than read from a turn event. Live and
historical paths must agree or a resumed session will render differently from a live one — this is
exactly what the existing "runtime reloads" regression test guards, and the same discipline applies.

**Sources.** `dist/core/extensions/types.d.ts:864-865`; `examples/extensions/status-line.ts`;
repo `extensions/chat-layout.ts:245-275`.

---

### 4. Cost and token count in the assistant header

**Value.** Cost is the number people actually want and Pi does not put it per-message. The data is
already in hand — no extra API call, no estimation, no latency.

**It is already on the object the extension holds.** `AssistantMessage.usage: Usage`
(`node_modules/@earendil-works/pi-ai/dist/types.d.ts:285`), and `Usage` carries
`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, optional `reasoning`, and
`cost: { input, output, cacheRead, cacheWrite, total }` (`types.d.ts:250-268`).
`decoratedAssistantUpdate` receives the whole `message` and passes it to `assistantHeader`, which
already reads `message.model` and `message.timestamp`. This is a formatter, nothing more.

**UX sketch.** Extend the existing `◆`-separated header, dropped first under width pressure:

```
 🤖 gpt-5.6-sol  ◆  medium  ◆  23:40:29  ◆  3.9s  ◆  1.2k↑ 340↓  ◆  $0.0041
```

Keep it opt-in and cohesive: one `header.metadata` array (see idea 8) rather than a `showCost` /
`showTokens` / `showCacheStats` toggle farm.

**Complexity/risk.** Low, with two honest caveats. (a) **Streaming**: usage arrives incrementally, so
cost renders as `—` until `message_end`; the header already re-renders per `updateContent`, so this
falls out naturally. (b) **Historical**: usage is persisted on the message in session entries, so
resumed sessions get real numbers — but a per-turn total is only trustworthy with idea 3's turn
grouping in place.

**Sources.** `node_modules/@earendil-works/pi-ai/dist/types.d.ts:250-290`;
repo `extensions/chat-layout.ts:164-202`.

---

### 5. Date separators for sessions that span days

**Value.** Fixes screenshot observation #5 — `23:39` with no date is ambiguous the moment a session
is resumed or crosses midnight, which is precisely when a long session needs scanning.

**UX sketch.** Emit a separator only when the calendar day changes between consecutive messages, and
on the first message of a resumed session:

```
──────────────────────── Today, 16 Jul ────────────────────────
```

Subtractive in spirit: it removes the need to put a date on every timestamp.

**Feasibility — two routes, and the public one is genuinely available.**

- **Public:** `pi.appendEntry(customType, data)` + `pi.registerEntryRenderer(customType, renderer)`.
  Documented for exactly this — *"For durable TUI-only content that should not be sent to the LLM,
  use `pi.appendEntry()` with `pi.registerEntryRenderer()`"* (`docs/extensions.md:1381`), custom
  entries *"do NOT participate in LLM context"* and *"can also render inside the chat transcript"*
  (`docs/extensions.md:1432`). Working example: `examples/extensions/entry-renderer.ts`. Ordering is
  handled upstream — *"Fixed custom session entries appended during assistant streaming to render
  before the live assistant message, matching persisted session order"* (`CHANGELOG.md:177`).
  **Cost:** it *writes to the session file*, which the README currently promises not to do
  (*"is not written back to the session"*). That promise is worth keeping.
- **Patch:** compute the separator inside the existing header render — no session writes, consistent
  with today's design, but stays on the fragile surface.

**Recommendation:** the patch route, to preserve the read-only-session guarantee.

**Complexity/risk.** Medium. Day comparison must use local time, and the memoized `formattedTimeCache`
is keyed by raw timestamp — a date-aware formatter needs its own cache or the key must incorporate
the format. Note `TIME_FORMATTER` (`chat-layout.ts:68`) is built once at module load with a fixed
locale.

**Sources.** `docs/extensions.md:1381,1432,1552-1563`; `examples/extensions/entry-renderer.ts`;
`CHANGELOG.md:177`; repo `README.md:115`.

---

### 6. Width-responsive header degradation

**Value.** The user runs split panes (screenshot observation #6). Today the header is assembled at
full length and then hard-cut by `truncateToWidth` (`chat-layout.ts:148`) — in a narrow pane the
duration and timestamp, the useful parts, are what get chopped, because they are last.

**UX sketch.** Degrade by priority rather than by truncation:

```
wide    🤖 gpt-5.6-sol  ◆  medium  ◆  23:40:29  ◆  3.9s  ◆  $0.0041
medium  🤖 gpt-5.6-sol  ◆  23:40:29  ◆  3.9s
narrow  🤖 23:40:29
```

Same for the divider, which at narrow widths is pure noise.

**Feasibility.** Entirely internal. `render(width)` already receives the width and the header is
already assembled from parts; this replaces one `truncateToWidth` call with an ordered drop list.
Both cache layers are already width-keyed (`cachedWidth === width`, `cached?.width === width`), so
resize correctness is free.

**Complexity/risk.** Low. Risk is taste, not mechanics: breakpoints must be picked from the actual
`visibleWidth` of the assembled parts, not from magic numbers, or wide emoji and long model IDs will
break them. Existing tests already assert `visibleWidth(line) <= width` at 60 and 80 columns.

**Sources.** repo `extensions/chat-layout.ts:132-149,175-196,329-368`;
`tests/chat-layout.test.ts:124,202-207`.

---

### 7. `/chat-layout` as a live, discoverable control surface

**Value.** Config lives in an undocumented-by-default JSON file at a path the user must know. In the
screenshot, discovering it took the *agent* two `read` tool calls. A command makes the feature
self-describing and pairs naturally with idea 1.

**UX sketch.**

```
/chat-layout            → prints resolved config + source path, reloads from disk
/chat-layout layout     → ctx.ui.select("Layout", ["alternating", "stacked"]) → applies live
```

**Feasibility — public API.** `pi.registerCommand` with `getArgumentCompletions` for tab-completion
(`types.d.ts:825-831`), and `ctx.ui.select(title, options, opts)` / `ctx.ui.confirm` / `ctx.ui.input`
(`types.d.ts:67-73`). Examples: `examples/extensions/commands.ts`, `examples/extensions/question.ts`.

**Complexity/risk.** Low, but **scope discipline required**. A command that *writes* config back to
disk turns this extension into a settings manager and forces a merge policy against hand-edited JSON.
Recommendation: the command reads and applies; the file stays the single source of truth. In-session
overrides should be explicitly session-scoped.

**Sources.** `dist/core/extensions/types.d.ts:67-73,825-831`; `examples/extensions/commands.ts`;
`examples/extensions/question.ts`.

---

### 8. Consolidate the header into one declarative `header.metadata` list

**Value.** Preventive and subtractive. Ideas 4, 5, and 6 each want to add a header field. Absent a
structure, that is three booleans, then five, then a config surface bigger than the feature. One
ordered list expresses all of them and is the natural home for idea 6's priority order.

**Config sketch.**

```json
{
  "header": {
    "metadata": ["thinking", "time", "duration", "cost"]
  }
}
```

Order is display order *and* drop order (last dropped first under width pressure). Omitting an item
hides it — no separate `show*` flags.

**Feasibility.** Pure refactor of `actorHeader` (`chat-layout.ts:132-149`) plus the validator in
`parseConfig`. `src/config.ts` already establishes the validation idiom: unknown values warn and fall
back rather than throw, and warnings are surfaced via `ctx.ui.notify` at
`chat-layout.ts:396`.

**Complexity/risk.** Low. Do this *before* ideas 4–6, not after; retrofitting is where the toggle
farm gets locked in.

**Sources.** repo `src/config.ts:43-110`; `extensions/chat-layout.ts:132-149`.

---

### 9. Shrink the patch surface behind a capability probe with a soft landing

**Value.** Insurance on the one risk that can break the extension outright for every user at once.
Today `decorateChatLayout` throws when the shape is wrong (`chat-layout.ts:288-295`) and
`session_start` catches it and notifies — good. But the probe only checks that four methods *exist*;
it cannot detect a *semantic* change (say, `render` returning lines with padding already applied, per
`CHANGELOG.md:1338`), which would produce a corrupted transcript rather than a clean error.

**Sketch.** Add a startup self-test: construct a throwaway `UserMessageComponent` with known text,
render at a known width, and assert the expected invariants (line count, OSC marker placement,
`visibleWidth <= width`). On mismatch, skip decoration and notify once — the user gets stock Pi
rendering instead of a mangled transcript. Pin the tested Pi range in `package.json`
`peerDependencies`, which is currently the maximally permissive `"*"`.

**Complexity/risk.** Medium. The self-test itself must not leak components or fire OSC sequences into
the real terminal — it renders to strings and discards, which is exactly what the existing tests
already do (`tests/chat-layout.test.ts:113-124`).

**Sources.** repo `extensions/chat-layout.ts:277-300`; `package.json` `peerDependencies`;
`CHANGELOG.md:1338,1313,196-211`; `dist/modes/interactive/components/user-message.d.ts`.

---

### 10. Ctrl+O-aware expanded headers

**Value.** Closes a documented gap: *"`Ctrl+O` … does not expand chat-layout headers"*
(`README.md:117`). Collapsed shows time + duration; expanded reveals cost breakdown, cache
hits, reasoning tokens, `responseId`.

**Feasibility — partial, and this is the interesting part.** Pi *does* expose expansion state:
`ctx.ui.getToolsExpanded()` / `setToolsExpanded(expanded)` (`types.d.ts:189-193`), and both
`MessageRenderOptions` and `EntryRenderOptions` are `{ expanded: boolean }` (`types.d.ts:816-821`),
passed to entry renderers (`examples/extensions/entry-renderer.ts` branches on `expanded`). So
*custom* entries get expansion for free — but built-in message decorations do not, because there is
no hook. The extension would have to poll or read `getToolsExpanded()` at render time and invalidate
caches on change, with no event to subscribe to (no `tools_expanded` event exists in the `ExtensionAPI`
`on(…)` overloads, `types.d.ts:837-877`).

**Complexity/risk.** Medium–high for the value. Cache invalidation on a state with no change event is
the awkward part.

**Sources.** `dist/core/extensions/types.d.ts:189-193,816-821,837-877`;
`examples/extensions/entry-renderer.ts`; repo `README.md:117`.

---

### 11. Terminal title / footer status integration

**Value.** Low-moderate. `ctx.ui.setTitle(title)` (`types.d.ts:113-114`, example
`examples/extensions/titlebar-spinner.ts`) and `ctx.ui.setStatus(key, text)` (`types.d.ts:78-79`,
example `examples/extensions/status-line.ts`) are clean public API — a title like
`pi · gpt-5.6-sol · 3.9s` is genuinely handy when Pi runs in a background tab.

**Why it ranks here.** It is **outside the extension's thesis**. This is a *chat layout* extension;
the title bar and footer are a different product. Pi's footer already carries model and token stats
via the built-in `FooterComponent` and `ReadonlyFooterDataProvider` (`types.d.ts:100-108`). Doing
this well means owning a second surface for marginal gain.

**Sources.** `dist/core/extensions/types.d.ts:78-79,100-114`;
`examples/extensions/titlebar-spinner.ts`; `examples/extensions/status-line.ts`.

---

### 12. Per-actor colour and divider-style theming

**Value.** Low, and it fights the platform. Users can already pick from `getAllThemes()` and the
extension already routes every colour through theme keys (`themed("accent", …)`, `themed("dim", …)`,
and the computed `thinking${Level}` keys at `chat-layout.ts:143`). Hard-coding hex colours in
`chat-layout.json` breaks under theme switching and in light terminals, and duplicates
`docs/themes.md`. If per-actor colour is wanted, expose a *theme key* (`"accent"`, `"success"`), never
a colour value — which is a two-line change, not a feature.

**Sources.** `dist/core/extensions/types.d.ts:173-187`; `docs/themes.md`;
repo `extensions/chat-layout.ts:80-86,143`.

---

## 3. Recommended top 3

### Quick win — **Live config reload + `ctx.ui.theme`** (ideas 1 + 2)

Ship together; they touch the same lifecycle code and are both mostly subtractive. Idea 1 makes the
loaded capability/version and resolved config visible, removes the reload round-trip for supported
fields, and unlocks every existing config knob; idea 2 deletes a `globalThis`/`Symbol.for` dependency
in favour of documented API. Combined: roughly a day, net fragility *reduced*, and it converts the
config file from "edit, restart, hope" into something the user can iterate on.

### Medium investment — **Turn-aware grouping** (idea 3, with ideas 8 + 6 alongside)

The biggest readability gain available, and the most defensible product position: chat-layout stops
decorating *messages* and starts structuring *turns* — something Pi core does not do and which no
amount of theming substitutes for. Sequence it as 8 (header structure) → 3 (turn grouping) → 6 (width
degradation) → 4 (cost), so the metadata contract exists before three features compete for header
space. Budget real time for historical turn inference on resume; that is where the correctness risk
lives, and the existing reload regression test is the model to follow.

### Ambitious — **Durable compatibility: capability probe + upstream renderer hook** (idea 9, plus advocacy)

The extension's ceiling is set by a private-prototype patch that upstream has already disturbed three
times (`outputPad`, OSC 133 padding, user-turn spacing). Two moves, in order: (a) ship the semantic
self-test with a soft landing so a Pi bump degrades to stock rendering instead of a broken
transcript; (b) make the case upstream for a public built-in-message decoration hook — the shape
already exists for custom types (`MessageRenderer` / `EntryRenderer` with `{ expanded }`), and this
extension is a concrete, well-tested motivating use case. If (b) lands, most of the patching in
`decorateChatLayout` deletes itself. High leverage, but the timeline is not yours to control — which
is exactly why (a) ships first and independently.

---

## 4. Features to avoid or defer

| Feature | Why not |
|---|---|
| **HTML/Markdown transcript export** | Duplicates core: `/export [file]` ships today (`docs/sessions.md:34`, `dist/core/export-html/`). Worse, export does **not** go through the TUI components — `grep` for `MessageComponent` in `dist/core/export-html/index.js` returns nothing — so chat-layout headers cannot appear there without reimplementing the whole pipeline. |
| **Boxed/bordered message bubbles** | Every content line gains border characters and per-line padding, multiplying render cost and colliding with `outputPad`, OSC 133 markers, and code blocks. The current flat divider+header gets the same scanning benefit for a fraction of the risk. |
| **Custom footer / header replacement** | `setFooter` / `setHeader` (`types.d.ts:100-112`) mean *owning* those components forever across Pi versions. Out of thesis, high maintenance. |
| **Restyling tool-call rendering** | Pi owns this via `renderCall` / `renderResult` with documented built-in inheritance per slot (`docs/extensions.md:1995`). Overriding built-in tool renderers to restyle them is core's job, not a layout extension's. |
| **Colour values in config** | See idea 12 — breaks theme switching, duplicates `docs/themes.md`. |
| **Writing metadata into session entries** | `appendEntry` makes it possible, but it would break the README's explicit promise that metadata is *"not written back to the session or sent to the model"* (`README.md:115`) and would pollute session files another Pi client must read. |
| **Per-message avatars / images** | Pi supports image *input*, not arbitrary inline terminal graphics; would require protocol-specific escape sequences (Kitty/iTerm2) with no portable fallback. |
| **A `showX` boolean per header field** | Scope creep by a thousand toggles. Idea 8 subsumes all of them in one ordered list. |
| **Ctrl+O-aware headers** (defer) | Idea 10 — no change event to hook, so cache invalidation is guesswork. Revisit if Pi adds an expansion event. |
| **Markdown/content restyling** | `MarkdownTheme` is Pi's, and content rendering is where performance and correctness bugs concentrate. Stay in the header/divider lane. |

---

## 5. Suggested roadmap

**0.2 — Fix what the screenshot showed** *(quick win)*
1. `ctx.ui.theme` replaces the `Symbol.for` global (idea 2) — subtractive, do it first.
2. Live config reload via watcher + debounce, teardown in `session_shutdown` (idea 1).
3. `/chat-layout` command: print resolved config, reload on demand (idea 7, read-only).
4. Pin `peerDependencies` to a tested Pi range (part of idea 9).

**0.3 — Structure before features**
5. `header.metadata` ordered list, with validation matching `parseConfig`'s warn-and-fall-back idiom (idea 8).
6. Width-responsive degradation driven by that order (idea 6).
7. Cost/tokens as a metadata item (idea 4).

**0.4 — The real differentiator**
8. Turn-aware grouping, live path first, then historical inference on resume, with a regression test per path (idea 3).
9. Date separators, once turn boundaries exist to hang them on (idea 5).

**0.5 — Durability**
10. Semantic capability self-test with soft landing to stock rendering (idea 9a).
11. Upstream: propose a public built-in-message decoration hook, citing this extension (idea 9b).

**Deferred:** Ctrl+O-aware headers (10), title/footer integration (11), per-actor colour (12).

Each step should extend the existing regression list in `README.md:137-147` — historical timestamps,
runtime reloads, streaming clones, thinking-level persistence, terminal width, OSC markers, vertical
spacing. That list is the extension's real moat; every feature above is only as good as its entry in it.
