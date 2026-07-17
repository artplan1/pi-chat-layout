# Terminal thinking-trace UI research

Research date: 2026-07-17. Scope: primary source code and official documentation only. The evaluation baseline is the locally inspected `extensions/chat-layout.ts:100-101,192-203`: dim ASCII frames `.`, `.o`, `.oO`, `oO`, `O`, blank in a four-column cell at 400 ms; completed blocks use static `.oO`.

## Evidence

| Source | Observed treatment | Relevant lesson for this extension |
|---|---|---|
| [Gemini CLI thinking message](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/cli/src/ui/components/messages/ThinkingMessage.tsx#L20-L95) and [history renderer](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/cli/src/ui/components/HistoryItemDisplay.tsx#L70-L93) | Inline thoughts are history items. The first gets a `Thinking...` heading; a left rule groups the subject and body, with secondary styling for body lines. Configuration exposes inline thinking as `off` or `full` ([official configuration](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/docs/reference/configuration.md#L286-L290)). | Full reasoning can remain transcript content rather than being replaced by a transient loader. **Judgment:** its heading, blank row, and rail add more vertical chrome than this project wants.
| [Gemini CLI spinner](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/cli/src/ui/components/GeminiSpinner.tsx#L22-L62) and [spinner wrapper](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/cli/src/ui/components/CliSpinner.tsx#L14-L32) | Screen-reader mode returns static alternative text and does not start the 30 ms color timer; `ui.showSpinner: false` suppresses the spinner. The setting is documented separately ([official configuration](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/docs/reference/configuration.md#L450-L453)). | Motion needs a static path. Animation should not be the only carrier of state.
| [OpenCode reasoning component](https://github.com/anomalyco/opencode/blob/08fb47373509ba64b13441061314eeacf4264f51/packages/tui/src/routes/session/index.tsx#L1572-L1631) and [header states](https://github.com/anomalyco/opencode/blob/08fb47373509ba64b13441061314eeacf4264f51/packages/tui/src/routes/session/index.tsx#L1635-L1673) | Minimal mode keeps one collapsed line to avoid layout shifts. Active content is headed `Thinking` (optionally with a title); completion changes that label to `Thought` and may append duration. The full Markdown body remains expandable. | Active/completed semantics can change without deleting the trace. **Judgment:** explicit labels improve clarity but compete with the existing quieter-than-Working hierarchy.
| [OpenCode spinner](https://github.com/anomalyco/opencode/blob/08fb47373509ba64b13441061314eeacf4264f51/packages/tui/src/component/spinner.tsx#L10-L24) | The normal spinner uses ten Braille frames at 80 ms; disabling animations replaces it with a static ellipsis plus the same text. | The fallback preserves status text and width while removing motion. Its Braille animation is excluded here by the plain-ASCII/no-font-assumption constraint.
| [Bubbles spinner definitions](https://github.com/charmbracelet/bubbles/blob/2a7b6fe8a974be085677926be0a3db0ae96b049f/spinner/spinner.go#L20-L83) and [tick handling](https://github.com/charmbracelet/bubbles/blob/2a7b6fe8a974be085677926be0a3db0ae96b049f/spinner/spinner.go#L123-L165) | Frames and cadence are data. Included presets range from 100 ms to 333 ms; the ellipsis preset uses `""`, `"."`, `".."`, `"..."` at 333 ms. The component renders frame strings as supplied. | **Inference:** a no-jitter ellipsis must be padded by the caller; equal display width is not enforced. The current four-column padded cell already follows the safer practice, at a deliberately slower cadence.
| [Ora options](https://github.com/sindresorhus/ora/blob/86403dcc176ad26a94f3005774f8c7fbebad2714/readme.md#L99-L123) and [completion API](https://github.com/sindresorhus/ora/blob/86403dcc176ad26a94f3005774f8c7fbebad2714/readme.md#L191-L217) | Ora defaults animation to interactive TTY/non-CI use; disabling it removes spinner/ANSI but retains text. Its completion methods stop animation and persist a final symbol/text. | Non-interactive output should retain semantic text, and completion should become stable rather than disappear.

## Design principles derived from the evidence

1. **Keep the trace separate from the activity signal.** Gemini and OpenCode retain reasoning content while treating animation as state decoration, not content ([Gemini history](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/cli/src/ui/components/HistoryItemDisplay.tsx#L79-L93), [OpenCode body](https://github.com/anomalyco/opencode/blob/08fb47373509ba64b13441061314eeacf4264f51/packages/tui/src/routes/session/index.tsx#L1599-L1629)).
2. **Freeze on completion; do not erase.** Ora persists completion and OpenCode switches `Thinking` to `Thought` ([Ora](https://github.com/sindresorhus/ora/blob/86403dcc176ad26a94f3005774f8c7fbebad2714/readme.md#L191-L217), [OpenCode](https://github.com/anomalyco/opencode/blob/08fb47373509ba64b13441061314eeacf4264f51/packages/tui/src/routes/session/index.tsx#L1648-L1673)).
3. **Provide a motion-off path with equivalent text.** Gemini substitutes alt text and OpenCode substitutes a static ellipsis ([Gemini](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/cli/src/ui/components/GeminiSpinner.tsx#L41-L62), [OpenCode](https://github.com/anomalyco/opencode/blob/08fb47373509ba64b13441061314eeacf4264f51/packages/tui/src/component/spinner.tsx#L12-L24)).
4. **Reserve constant display width.** This is a project-specific inference from Bubbles accepting unequal frame strings unchanged ([source](https://github.com/charmbracelet/bubbles/blob/2a7b6fe8a974be085677926be0a3db0ae96b049f/spinner/spinner.go#L20-L23)) and from the no-jitter requirement.
5. **Prefer state change over extra structure.** OpenCode proves an explicit active/completed label is viable, but the local constraints favor changing motion to stillness inside the existing one-line gutter rather than adding a heading or box. This is a design judgment, not a sourced usability fact.

## Ranked treatments

Examples show plain text without color. In the current renderer, a four-column marker plus spacing precedes each paragraph start; continuation lines align with the content.

### 1. Current trail, with a bounded motion-off refinement

Active, 400 ms per frame. Every paragraph start receives the same frame; one paragraph is shown at each timestamp:

```text
t=0 ms       .    Inspecting renderer behavior
t=400 ms     .o   Inspecting renderer behavior
t=800 ms     .oO  Inspecting renderer behavior
t=1200 ms     oO  Inspecting renderer behavior
t=1600 ms      O  Inspecting renderer behavior
t=2000 ms         Inspecting renderer behavior
```

Completed (static, indefinitely), including the preserved blank line between paragraphs:

```text
 .oO  Inspecting renderer behavior

 .oO  Evaluating alternatives
```

Motion-off / non-animated rendering (no timer):

```text
 .oO  Inspecting renderer behavior

 .oO  Evaluating alternatives
```

**Judgment:** best fit. ASCII is terminal- and font-independent, the padded cell prevents horizontal jitter, there is no added row or box, and motion-to-stillness communicates completion while leaving every paragraph visible. The static fallback intentionally sacrifices animated state distinction; surrounding streaming state still determines whether work is active.

### 2. Padded ASCII ellipsis with an explicit completion word

Active, 333 ms per frame, mirroring Bubbles' ellipsis cadence but padding every frame:

```text
.     Thinking: Inspecting renderer behavior
..    Thinking: Evaluating alternatives
...   Thinking: Inspecting renderer behavior
      Thinking: Evaluating alternatives
```

Completed:

```text
      Thought: Inspecting renderer behavior
      Thought: Evaluating alternatives
```

**Judgment:** semantically clearest, but `Thinking:` repeated on every paragraph is louder and wider; putting it only once would weaken multi-paragraph alignment. It also makes thinking compete with the separate Working state.

### 3. Static disclosure header plus indented trace

Active (no animation):

```text
...  Thinking
     Inspecting renderer behavior

     Evaluating alternatives
```

Completed:

```text
     Thought
     Inspecting renderer behavior

     Evaluating alternatives
```

**Judgment:** follows OpenCode's explicit state transition and is inherently reduced-motion, but costs a header row and blank-row structure. That conflicts with minimal vertical chrome and is not justified for a trace that must remain fully visible.

## Recommendation

**Make a bounded refinement:** keep the current `.oO` visual, 400 ms cadence, dim styling, fixed-width frames, and static `.oO` completion exactly as designed; add only a no-animation path that renders static `.oO` without scheduling frame updates. Do not prototype ellipsis, labels, a rail, or a box. The current treatment fits the stated Ghostty/ASCII/no-jitter/low-chrome constraints better than the primary-source alternatives, while the motion-off path is the one evidence-backed capability it lacks.
