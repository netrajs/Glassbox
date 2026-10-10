# Glassbox: see through your AI

**AI writes half your code now. Glassbox shows you which half, and walks you through it.**

When Claude Code changes your project, you normally get "Sifting… Brainstorming…" and a wall of diff. Glassbox makes every change visible and understandable instead:

- **Watch every edit happen.** The old code turns red, gets erased, and the new code types itself in green, right in your editor. Then the screen settles on **BEFORE** above **AFTER** so you can compare.
- **Approve before it lands (Review mode).** Claude pauses before each change. Approve it, or redirect it ("put the button at the bottom instead") and Claude adapts.
- **Watch it build live (Watch mode).** Claude works freely while Glassbox plays each change as it happens, with **Pause**, **Stop** and **Tell Claude…** available at any moment.
- **Understand any change.** Plain-English *what* and *why* for every change, an **Ask** box for questions, and a quick **quiz** to check you really get it.
- **Replay anything.** Every change is saved to a timeline. Replay one change, or a whole Claude session as a guided tour.
- **Find your blind spots.** Glassbox tracks which AI-written code you've actually reviewed. Files are marked in the Explorer (red / yellow / green) and the panel tells you, for example, *"68% of the AI-written code in this project has never been reviewed"*, with a **Walk me through** button for each file.

## Install

1. In VS Code (also Cursor, Windsurf, Antigravity): **Extensions → ⋯ → Install from VSIX…** and pick `glassbox-x.y.z.vsix`.
2. Open your project folder and click the **Glassbox** icon (the glass cube) in the left sidebar.
3. Click **Connect Claude Code**, then start (or restart) Claude Code in that folder.

That's it. Use Claude Code as usual, in VS Code's terminal, the Claude Code panel, or the Claude desktop app, and Glassbox shows what it does.

**Optional:** run **Glassbox: Set API Key** to get plain-English explanations, answers and quizzes. The key is stored encrypted by VS Code and never written to your project. Without a key, Glassbox shows Claude's own words about each change.

## Not using VS Code? Glassbox Web

For people who run Claude Code in a terminal or the Claude desktop app:

```bash
npx glassbox            # in your project folder (once published to npm)
npm run web -- C:\path\to\your\project   # from a copy of this repository
```

A browser tab opens with the same panel, plus a code view that plays each change. Set `ANTHROPIC_API_KEY` in your environment to turn on explanations. Run `npx glassbox disconnect` to remove Glassbox's hooks from a project.

## Other AI tools

Run **Glassbox: Watch Other AI Tools** to also record changes made by Cursor's agent, Copilot, Antigravity and others. They can't be paused (only Claude Code has hooks), but they're played live, saved to the timeline and counted in Blind Spots.

## How it works

Glassbox uses [Claude Code hooks](https://docs.claude.com/en/docs/claude-code/hooks). **Connect** adds a few entries to your project's `.claude/settings.local.json` (a personal, git-ignored file) that send each step Claude takes to Glassbox on `127.0.0.1` before it runs:

```
Claude Code ──hook (curl)──► Glassbox (local server inside VS Code, or `npx glassbox`)
            ◄── allow / redirect / pause / stop ──┘
```

- Everything stays on your machine. The only network calls are to the Claude API, and only if you add a key.
- If Glassbox isn't running, the hooks do nothing and Claude Code works exactly as before.
- **Disconnect Claude Code** removes Glassbox's entries and leaves your own settings untouched.

## Commands

| Command | What it does |
|---|---|
| Glassbox: Connect / Disconnect Claude Code | Add or remove Glassbox's hooks for this project |
| Glassbox: Pause / Resume / Stop Claude | Same as the panel buttons (also on the status bar) |
| Glassbox: Tell Claude… | Send Claude a message before its next step |
| Glassbox: Set API Key / Remove API Key | Turn plain-English explanations on or off |
| Glassbox: Watch Other AI Tools (on/off) | Also record changes made by other AI tools |
| Glassbox: Show Log | What Glassbox received and decided |

## Settings

| Setting | Default | |
|---|---|---|
| `glassbox.model` | `claude-opus-5-5` | Model for explanations. `claude-haiku-5-5` is faster and cheaper. |
| `glassbox.port` | `7337` | Local port for the hooks (the next free one is used if taken) |
| `glassbox.watchOtherTools` | `false` | Record changes from other AI tools by watching files |

## Development

```bash
npm install && npm --prefix webview-ui install
npm run compile          # extension + Glassbox Web + panel UI
npm run test:core        # core logic tests
npx @vscode/vsce package # build the .vsix
```

Press **F5** to try the extension in a development window.

Built entirely by voice with [Wispr Flow](https://wisprflow.ai).
