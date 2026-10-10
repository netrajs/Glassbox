import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as hooks from '../hooks';
import { DEFAULT_PORT } from '../server';
import { WebSession } from './session';

// `npx glassbox` — Glassbox in a browser tab, for people using Claude Code in a terminal
// or the Claude desktop app instead of VS Code.

const USAGE = `Glassbox Web: see through your AI.

Usage:
  glassbox [project-folder] [--port 7337] [--no-open]   Start Glassbox for a project (default: this folder)
  glassbox disconnect [project-folder]                  Remove Glassbox's hooks from the project

Explanations, questions and quizzes need ANTHROPIC_API_KEY set in your environment.
Set GLASSBOX_MODEL to choose the model (default: claude-opus-5-5).`;

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		console.log(USAGE);
		return;
	}

	if (args[0] === 'disconnect') {
		const root = path.resolve(args[1] ?? process.cwd());
		console.log(hooks.disconnect(root) ? `Glassbox hooks removed from ${root}` : `Glassbox wasn't connected in ${root}`);
		return;
	}

	const portFlag = args.indexOf('--port');
	const preferredPort = portFlag >= 0 ? Number(args[portFlag + 1]) || DEFAULT_PORT : DEFAULT_PORT;
	const folder = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
	const root = path.resolve(folder ?? process.cwd());
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
		console.error(`Not a folder: ${root}`);
		process.exitCode = 1;
		return;
	}

	const uiDir = path.join(__dirname, '..', 'webview-ui', 'dist');
	const log = (message: string) => console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
	const session = new WebSession(root, uiDir, process.env.ANTHROPIC_API_KEY, process.env.GLASSBOX_MODEL || 'claude-opus-5-5', log);

	const port = await session.server.start(preferredPort);
	const settings = hooks.connect(root, port);
	const url = `http://127.0.0.1:${port}`;

	console.log(`
  Glassbox Web is running for ${root}

  Open:      ${url}
  Hooks:     ${settings}
  Explain:   ${process.env.ANTHROPIC_API_KEY ? 'on (ANTHROPIC_API_KEY found)' : 'off (set ANTHROPIC_API_KEY to turn on)'}

  Start (or restart) Claude Code in this folder and give it a task.
  Press Ctrl+C to stop Glassbox. Claude Code keeps working normally without it.
`);

	if (!args.includes('--no-open')) {
		openBrowser(url);
	}
}

function openBrowser(url: string): void {
	const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
	const commandArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
	try {
		spawn(command, commandArgs, { detached: true, stdio: 'ignore' }).unref();
	} catch {
		// Opening the browser is a convenience; the URL is printed above.
	}
}

main().catch(err => {
	console.error(err instanceof Error ? err.message : err);
	process.exitCode = 1;
});
