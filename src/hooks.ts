import * as fs from 'fs';
import * as path from 'path';

// Reads and writes the Claude Code hook settings for a project.
// We use .claude/settings.local.json because it's personal (not committed to git).

// Glassbox hears about every tool call so it can pause or stop Claude at any step;
// only file edits are shown on the Stage and recorded.
const PRE_MATCHER = '*';
const POST_MATCHER = 'Edit|Write|MultiEdit';
// Every Glassbox hook URL contains this, which is how we recognise our own entries.
const MARKER = '/glassbox/';

interface HookCommand { type: string; command: string; timeout?: number }
interface HookGroup { matcher?: string; hooks: HookCommand[] }
type HookSettings = Record<string, HookGroup[]>;

export function settingsPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.claude', 'settings.local.json');
}

// `|| true` keeps Claude Code quiet when VS Code (and so Glassbox) isn't running:
// curl fails, the hook prints nothing, and Claude continues normally.
function curlCommand(port: number, route: 'pre' | 'post' | 'prompt' | 'stop'): string {
	return `curl -s --connect-timeout 2 -X POST -H "Content-Type: application/json" --data-binary @- http://127.0.0.1:${port}${MARKER}${route} || true`;
}

export function connect(workspaceRoot: string, port: number): string {
	const file = settingsPath(workspaceRoot);
	const settings = readSettings(file);
	const hooks: HookSettings = removeGlassboxHooks(settings.hooks ?? {});

	(hooks.PreToolUse ??= []).push({
		matcher: PRE_MATCHER,
		hooks: [{ type: 'command', command: curlCommand(port, 'pre'), timeout: 600 }],
	});
	(hooks.PostToolUse ??= []).push({
		matcher: POST_MATCHER,
		hooks: [{ type: 'command', command: curlCommand(port, 'post'), timeout: 10 }],
	});
	// When the user sends Claude a request, and when Claude finishes its turn.
	(hooks.UserPromptSubmit ??= []).push({
		hooks: [{ type: 'command', command: curlCommand(port, 'prompt'), timeout: 10 }],
	});
	(hooks.Stop ??= []).push({
		hooks: [{ type: 'command', command: curlCommand(port, 'stop'), timeout: 10 }],
	});

	settings.hooks = hooks;
	writeSettings(file, settings);
	return file;
}

export function disconnect(workspaceRoot: string): boolean {
	const file = settingsPath(workspaceRoot);
	if (!fs.existsSync(file)) {
		return false;
	}
	const settings = readSettings(file);
	if (!settings.hooks) {
		return false;
	}
	const hooks = removeGlassboxHooks(settings.hooks);
	if (Object.keys(hooks).length === 0) {
		delete settings.hooks;
	} else {
		settings.hooks = hooks;
	}
	writeSettings(file, settings);
	return true;
}

export function isConnected(workspaceRoot: string): boolean {
	const file = settingsPath(workspaceRoot);
	if (!fs.existsSync(file)) {
		return false;
	}
	return fs.readFileSync(file, 'utf8').includes(MARKER);
}

// Removes only Glassbox's own entries, keeping any hooks the user set up themselves.
function removeGlassboxHooks(hooks: HookSettings): HookSettings {
	const result: HookSettings = {};
	for (const [event, groups] of Object.entries(hooks)) {
		const kept = groups
			.map(group => ({ ...group, hooks: group.hooks.filter(h => !h.command?.includes(MARKER)) }))
			.filter(group => group.hooks.length > 0);
		if (kept.length > 0) {
			result[event] = kept;
		}
	}
	return result;
}

function readSettings(file: string): Record<string, any> {
	if (!fs.existsSync(file)) {
		return {};
	}
	const text = fs.readFileSync(file, 'utf8').trim();
	if (!text) {
		return {};
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${file} contains invalid JSON. Fix it first so Glassbox doesn't overwrite your settings.`);
	}
}

function writeSettings(file: string, settings: object): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}
