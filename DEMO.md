# Glassbox demo script (≈ 3 minutes)

A recording plan for the Wispr Flow submission. Every prompt to Claude is dictated with Wispr Flow.

## Before recording
- Open the `glassbox-playground` folder in VS Code with Glassbox installed, panel open, **Connect Claude Code** done.
- Clear the timeline (Timeline → Clear) and set the panel to **Review**.
- Optional: set an API key so explanations and quizzes are on.
- Close other notifications; zoom the editor a little so code is readable on video.

## 1. The problem (0:00–0:20)
Say: *"When I vibe code, Claude says 'Sifting… Brainstorming…' and dumps a diff I never read. I'm shipping code I don't understand."*
Show a plain Claude Code run with a long diff scrolling past.

## 2. Review mode (0:20–1:00)
Dictate to Claude: *"Make greet return a friendlier message based on the time of day."*
- The banner turns blue: **WAITING FOR YOU**.
- In the editor the old line goes red, gets erased, and the new code types in green; then BEFORE / AFTER.
- Point at the explanation in the panel (what + why).
- Click **Redirect**, dictate *"use an emoji instead"*, Ctrl+Enter. Claude adapts.
- **Approve** the next version; it lands and flashes green.

## 3. Watch mode: building from scratch (1:00–1:50)
Switch to **Watch**. Dictate: *"Build a small to-do app in a todo folder with add, complete and list."*
- The banner is green, **CLAUDE IS WORKING**, with each step: Reading… Writing… Running…
- New files type themselves in, change after change.
- Click **⏸ Pause**: banner turns yellow, the typing freezes, Claude waits.
- Type in **Tell Claude**: *"add a deleteTodo function too"* → Send. Claude resumes with your message.
- Click **■ Stop** near the end: banner turns red, Claude stops.

## 4. Understand it (1:50–2:30)
- Timeline: click a change. The real file opens and the code is highlighted.
- **Explain this change**, then **Ask**: *"why is completeTodo using an index?"*
- **Quiz me**: answer correctly → *"Marked as reviewed."*

## 5. Blind spots (2:30–2:55)
- Open the **Blind spots** tab: *"84% of the AI-written code in this project has never been reviewed."*
- Show the red **AI** badges in the Explorer.
- Click **Walk me through** on a file; watch the percentage drop.

## 6. Close (2:55–3:00)
Say: *"Glassbox: see through your AI. And I built the whole thing by talking to Claude with Wispr Flow."*
Optionally flash Glassbox Web running in a browser for terminal users.
