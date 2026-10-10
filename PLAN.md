# Glassbox — Build Plan

> **See through your AI.** Glassbox shows you every change your AI coding agent makes: where, what and why. It also tracks which AI-written code you have never actually understood.

## What Glassbox is

When Claude Code edits your project, Glassbox:
1. **Shows** the change: it flies the editor to the exact lines, highlights what is removed and types out the new code in a preview.
2. **Explains** it: a plain-English summary and the *why*, taken from Claude's own reasoning.
3. **Lets you steer** it: Approve, or Redirect ("put it at the bottom instead") and Claude adapts.
4. **Remembers** it: every change goes into a replayable timeline.
5. **Exposes blind spots**: a map of AI-written code you have never reviewed.

It works with Claude Code wherever it runs: as a VS Code extension (also Cursor, Windsurf, Antigravity), or as a browser tab (`npx glassbox`) for terminal and Claude app users.

**Two modes**
- **Review mode**: Claude pauses before each edit until you approve or redirect.
- **Watch mode** (default for big tasks): no pausing. Glassbox records everything so you can watch it as a guided replay later.

## How it works

```
Claude Code ──PreToolUse hook (curl)──►  Glassbox local server (127.0.0.1:7337)
            ◄── allow / deny + reason ──        │
Claude Code ──PostToolUse hook (curl)─►        │
                                                ▼
                         Stage (editor highlights + typing preview)
                         Side panel (explanation, approve/redirect, timeline, blind spots)
```

## Tech stack

| Part | Tech |
|---|---|
| Extension | TypeScript, VS Code Extension API, esbuild |
| Bridge | Claude Code hooks + `curl` + Node `http` server |
| Side panel | React + Vite in a webview, VS Code theme colours |
| Explanations | Claude API (`@anthropic-ai/sdk`, Claude Haiku 4.5), key in SecretStorage |
| Storage | JSON in the extension's workspace storage |
| Web version | Node CLI + React + Vite + Monaco editor |
| Voice (optional) | Browser `speechSynthesis` |
| Packaging | `@vscode/vsce` → `.vsix` |

## Phases

### ✅ Phase 0 — Setup
Extension skeleton created with `yo code` (TypeScript + esbuild), builds and runs with F5.

### ✅ Phase 1 — The bridge
Claude Code pauses before every edit and waits for Glassbox.
- `src/server.ts`: local server (port 7337, falls back to the next free port); `/glassbox/pre` waits for a decision, `/glassbox/post` records completion; auto-answers before the hook's 10-minute timeout.
- `src/hooks.ts`: **Glassbox: Connect / Disconnect Claude Code** write/remove hooks in `.claude/settings.local.json`, keeping the user's own settings.
- `src/approval.ts`: temporary dialog with Approve / Redirect…; queues simultaneous edits.
- `src/extension.ts`: starts everything, status bar item, log channel.
- Safe by design: if VS Code isn't running, the hook prints nothing and Claude continues normally.

Verified with the real Claude Code.

### ✅ Phase 2 — The Stage ⭐ (core visual)
Every edit is shown inside the real editor before it happens.
- `src/stage/flyTo.ts`: open the file, locate `old_string`, scroll it to the centre.
- `src/stage/decorations.ts`: removed code = red background + strikethrough; the area being changed gets a glowing border.
- `src/stage/preview.ts`: diff view of the current file vs a **virtual preview document** where the new code is typed in character by character; handles `Edit`, `MultiEdit` and `Write` (new file = empty left side).
- After approval: a short "materialize" flash on the new code.
- **Done when:** you watch each Claude edit play out in the editor before approving.

### ✅ Phase 3 — The side panel
Replaces the dialog with a proper Glassbox panel in the sidebar.
- `src/panel/PanelProvider.ts`: webview view, messages between extension and React app.
- `webview-ui/` (React + Vite): **Pending edit card** (file, lines, preview, Approve / Redirect with a text box Wispr Flow can dictate into), **queue** ("2 of 5", Approve all), **Review / Watch** mode switch.
- **Done when:** you can review and redirect Claude entirely from the panel.

### ✅ Phase 4 — Explanations
Every change gets a plain-English explanation.
- `src/explain/transcript.ts`: read Claude's latest reasoning from `transcript_path`.
- `src/explain/explainer.ts`: Claude Haiku 4.5 turns the edit + reasoning into a one-line summary, 1–3 steps and a "why".
- Setup flow for the API key (SecretStorage); fallback to Claude's own text with no key.
- Preview shows immediately; the explanation fades in when ready.
- **Done when:** each edit has a clear human explanation in the panel.

### ✅ Phase 5 — Timeline & Replay
Nothing the AI does is lost.
- Save each change (before/after snapshot, explanation, time, session) on PostToolUse.
- **Timeline** list in the panel, grouped by Claude session.
- **Replay** any change, or **"Replay this session"**: a guided tour of everything Claude did, one edit after another.
- Watch mode uses this: no pausing, watch it all afterwards.
- **Done when:** you can replay what Claude did an hour ago as a guided walkthrough.

### ✅ Phase 6 — Blind Spots map ⭐ (the unique feature)
Shows how much of your code is AI-written and never reviewed.
- Track per file: lines written by AI, lines reviewed in Glassbox (approved, or watched in replay).
- File explorer badges: 🟢 reviewed, 🟡 partly, 🔴 never reviewed (`FileDecorationProvider`).
- Panel overview: "68% of AI-written code in this project has never been reviewed", with the worst files first.
- **"Walk me through this file"**: a guided explanation of a red file's AI-written parts.
- **Done when:** you can see, and fix, your blind spots.

### ✅ Phase 7 — Glassbox Web (for Claude app / terminal users)
Same experience without VS Code.
- Move the server, storage and explanation logic into a shared `core/`.
- `npx glassbox`: starts the core and opens a browser tab with a **Monaco** editor, the same panel UI, highlights and typing preview.
- **Done when:** a terminal-only Claude Code user gets the full experience in the browser.

### ✅ Phase 8 — Extras (partly)
- Done: voice (read explanations aloud), quiz-back, other AI tools (file watcher), live Watch mode with Pause / Stop / Tell Claude.
- Not done: live app glow (needs code inside the running app; left out).
- Voice: read explanations aloud (toggle).
- Quiz-back: "Where would you change the sidebar width now?"
- Live app glow: highlight the matching UI element in a running preview.
- File-watcher mode for Cursor / Antigravity agents (no pausing, shows changes after the fact).

### ✅ Phase 9 — Polish & ship
- Error handling, icon, animations, onboarding ("Connect Claude Code" welcome screen).
- Demo project (small React app) and demo script.
- `npx @vscode/vsce package` → `glassbox.vsix`; test in VS Code and Cursor.
- README with 3-step install.
- Edit the screen recording and submit early.

## Priorities if time runs short
Never cut: **Phases 1–3** (the product) and **Phase 6** (the unique feature).
Cut in this order: Phase 8 → Phase 7 → Phase 5 session tour → Phase 4 polish.

## Suggested schedule
| Days | Phase |
|---|---|
| 1 | 0–1 ✅ |
| 2–3 | 2 Stage |
| 4–5 | 3 Side panel |
| 6 | 4 Explanations |
| 7–8 | 5 Timeline & Replay |
| 9–10 | 6 Blind Spots |
| 11 | 7 Glassbox Web (or polish if behind) |
| 12–13 | 9 Polish, recording, submit |
