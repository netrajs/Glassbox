import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Recorder } from '../timeline/recorder';
import { ChangeRecord } from '../timeline/store';

// Watches files on disk to catch changes made by other AI tools (Cursor, Copilot, Antigravity…)
// that don't go through Claude Code's hooks. They can't be paused, but they're recorded,
// played live, and counted in the Blind Spots map. Changes the user types are ignored.

const MAX_FILES = 3000;
const MAX_FILE_BYTES = 256 * 1024;
const EXCLUDE = '**/{node_modules,.git,dist,out,build,.next,.vscode-test,coverage}/**';
// A save the user made from the editor shortly before a disk change means it was the user.
const USER_SAVE_WINDOW_MS = 1500;
const DEBOUNCE_MS = 300;

export class OtherToolsWatcher implements vscode.Disposable {
	private readonly snapshots = new Map<string, string>();
	private readonly userSaves = new Map<string, number>();
	private readonly pending = new Map<string, NodeJS.Timeout>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private sessionId = '';

	constructor(
		private readonly root: string,
		private readonly recorder: Recorder,
		private readonly onRecorded: (record: ChangeRecord) => void,
	) {}

	async start(): Promise<number> {
		this.sessionId = `other-tools-${new Date().toISOString().slice(0, 16)}`;
		const files = await vscode.workspace.findFiles(new vscode.RelativePattern(this.root, '**/*'), EXCLUDE, MAX_FILES);
		for (const uri of files) {
			this.snapshot(uri.fsPath);
		}

		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, '**/*'));
		this.subscriptions.push(
			watcher,
			watcher.onDidChange(uri => this.schedule(uri.fsPath)),
			watcher.onDidCreate(uri => this.schedule(uri.fsPath)),
			vscode.workspace.onWillSaveTextDocument(e => this.userSaves.set(key(e.document.uri.fsPath), Date.now())),
		);
		return this.snapshots.size;
	}

	dispose(): void {
		this.subscriptions.forEach(s => s.dispose());
		this.pending.forEach(timer => clearTimeout(timer));
	}

	private schedule(file: string): void {
		if (isExcluded(this.root, file)) {
			return;
		}
		clearTimeout(this.pending.get(key(file)));
		this.pending.set(key(file), setTimeout(() => this.check(file), DEBOUNCE_MS));
	}

	private check(file: string): void {
		this.pending.delete(key(file));
		const after = readText(file);
		if (after === undefined) {
			return;
		}
		const before = this.snapshots.get(key(file)) ?? '';
		this.snapshots.set(key(file), after);
		if (before === after) {
			return;
		}
		const savedByUser = Date.now() - (this.userSaves.get(key(file)) ?? 0) < USER_SAVE_WINDOW_MS;
		if (savedByUser || this.recorder.isClaudeEditing(file)) {
			return;
		}
		const record = this.recorder.external(file, this.root, before, after, this.sessionId);
		if (record) {
			this.onRecorded(record);
		}
	}

	private snapshot(file: string): void {
		const text = readText(file);
		if (text !== undefined) {
			this.snapshots.set(key(file), text);
		}
	}
}

// Text files only: skips big files and anything that looks binary.
function readText(file: string): string | undefined {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
			return undefined;
		}
		const text = fs.readFileSync(file, 'utf8');
		return text.includes('\u0000') ? undefined : text;
	} catch {
		return undefined;
	}
}

function isExcluded(root: string, file: string): boolean {
	const parts = path.relative(root, file).split(/[\\/]/);
	return parts.some(p => ['node_modules', '.git', 'dist', 'out', 'build', '.next', '.vscode-test', 'coverage', '.claude'].includes(p));
}

function key(file: string): string {
	return path.resolve(file).toLowerCase();
}
