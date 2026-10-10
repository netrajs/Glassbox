import * as path from 'path';
import * as vscode from 'vscode';
import { Approvals } from './approval';
import { ExplainService } from './explain/service';
import * as hooks from './hooks';
import { DEFAULT_PORT, GlassboxServer } from './server';
import { PanelProvider } from './panel/PanelProvider';
import { PREVIEW_SCHEME, PreviewProvider, Stage } from './stage/stage';
import { GlassboxState } from './state';
import { OtherToolsWatcher } from './agents/otherTools';
import { BlindSpotsService } from './timeline/blindspotsService';
import { Recorder } from './timeline/recorder';
import { Replayer } from './timeline/replayer';
import { TimelineStore } from './timeline/store';
import { EDIT_TOOLS, HookInput } from './types';
import { LiveView, WatchController } from './watch';

let server: GlassboxServer | undefined;
let state: GlassboxState | undefined;

// Called once when VS Code starts (see "activationEvents" in package.json).
export async function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Glassbox');
	// Last few log lines, also exposed in the health check for debugging.
	const recentLog: string[] = [];
	const log = (message: string) => {
		const line = `[${new Date().toLocaleTimeString()}] ${message}`;
		output.appendLine(line);
		recentLog.push(line);
		if (recentLog.length > 30) {
			recentLog.shift();
		}
	};

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	status.command = 'glassbox.connect';
	context.subscriptions.push(output, status);

	state = new GlassboxState(context.workspaceState);
	const preview = new PreviewProvider();
	const stage = new Stage(preview);
	const explainer = new ExplainService(context.secrets);
	const approvals = new Approvals(stage, explainer);
	const timeline = new TimelineStore((context.storageUri ?? context.globalStorageUri).fsPath);
	const recorder = new Recorder(timeline, explainer);
	const replayer = new Replayer(stage, timeline, message => vscode.window.setStatusBarMessage(`$(check) Glassbox: ${message}`, 4000));
	const watch = new WatchController();
	const firstRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const blindSpots = new BlindSpotsService(timeline, firstRoot);
	const panel = new PanelProvider(context.extensionUri, state, approvals, timeline, replayer, watch, explainer, blindSpots);
	let otherTools: OtherToolsWatcher | undefined;
	const setOtherTools = async (on: boolean) => {
		otherTools?.dispose();
		otherTools = undefined;
		const root = firstRoot();
		if (on && root) {
			otherTools = new OtherToolsWatcher(root, recorder, record => {
				log(`Another AI tool changed ${record.file}`);
				if (state?.followLive) {
					replayer.live(record.id);
				}
			});
			const count = await otherTools.start();
			log(`Watching ${count} files for changes by other AI tools`);
		}
	};
	setOtherTools(vscode.workspace.getConfiguration('glassbox').get<boolean>('watchOtherTools', false));
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, preview),
		explainer.register(),
		explainer.onDidChangeKey(() => state?.refresh()),
		approvals.register(),
		panel.register(),
		blindSpots.register(),
		{ dispose: () => otherTools?.dispose() },
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('glassbox.watchOtherTools')) {
				setOtherTools(vscode.workspace.getConfiguration('glassbox').get<boolean>('watchOtherTools', false));
			}
		}),
		vscode.commands.registerCommand('glassbox.toggleOtherTools', async () => {
			const config = vscode.workspace.getConfiguration('glassbox');
			const on = !config.get<boolean>('watchOtherTools', false);
			await config.update('watchOtherTools', on, vscode.ConfigurationTarget.Workspace);
			vscode.window.showInformationMessage(
				on
					? 'Glassbox is now also recording changes made by other AI tools (Cursor, Copilot, Antigravity…). They can be replayed, but not paused.'
					: 'Glassbox stopped watching other AI tools.',
			);
		}),
		// Pause / Resume / Stop act on Claude and on the on-screen playback together.
		vscode.commands.registerCommand('glassbox.pauseClaude', () => {
			log('Pause pressed');
			watch.pause();
			replayer.pausePlayback();
		}),
		vscode.commands.registerCommand('glassbox.resumeClaude', () => {
			log('Resume pressed');
			watch.resume();
			replayer.resumePlayback();
		}),
		vscode.commands.registerCommand('glassbox.stopClaude', () => {
			log('Stop pressed');
			watch.stop();
			replayer.stopPlayback();
		}),
		vscode.commands.registerCommand('glassbox.tellClaude', async (text?: string) => {
			const message =
				text ??
				(await vscode.window.showInputBox({
					title: 'Glassbox: tell Claude',
					prompt: "Delivered before Claude's next step",
					ignoreFocusOut: true,
				}));
			if (message?.trim()) {
				log(`Message for Claude: ${message.trim()}`);
				watch.send(message);
				replayer.resumePlayback();
			}
		}),
		// Opens the real file at a change from the timeline.
		vscode.commands.registerCommand('glassbox.openChange', (id: number) => {
			const record = timeline.get(id);
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (record && root) {
				timeline.markReviewed([id]);
				stage.revealChange(path.join(root, record.file), record.plan);
			}
		}),
		// The status bar always shows Claude's state, coloured when paused or stopped.
		watch.onDidChange(() => showLiveStatus(status, watch.view(approvals.pendingEdit?.file), server?.port)),
		approvals.onDidChange(() => showLiveStatus(status, watch.view(approvals.pendingEdit?.file), server?.port)),
		approvals.onDidDecide(({ file, decision, instruction, input, root, explanation, request }) => {
			if (decision?.kind === 'allow') {
				state?.addActivity('approved', file);
				recorder.rememberReview(input, root, { explanation, request });
			} else if (decision?.kind === 'deny') {
				state?.addActivity('redirected', file, instruction || 'rejected');
			} else {
				state?.addActivity('skipped', file);
			}
		}),
	);

	server = new GlassboxServer({
		onPreEdit: async (input: HookInput) => {
			const root = workspaceRootFor(input.cwd);
			if (!root) {
				// The edit belongs to a project open in a different window.
				log(`Ignored an edit from ${input.cwd}: that folder isn't open in this window.`);
				return undefined;
			}
			// Pause / Stop / "Tell Claude" apply to every step Claude takes, not only edits.
			const control = await watch.gate(input, root);
			if (control) {
				log(`Glassbox control on ${input.tool_name}: ${control.kind}`);
				return control;
			}
			if (!EDIT_TOOLS.has(input.tool_name ?? '')) {
				return undefined;
			}
			// Remember the file as it is now, so the timeline can record exactly what changed.
			recorder.before(input, root);
			if (state?.mode === 'watch') {
				// Watch mode: don't pause Claude; the change is highlighted once it lands.
				log(`Claude is editing (watch mode): ${input.tool_input?.file_path}`);
				return undefined;
			}
			log(`Claude wants to ${input.tool_name}: ${input.tool_input?.file_path}`);
			panel.reveal();
			const decision = await approvals.ask(input, root);
			log(`  → ${decision ? decision.kind : 'no decision (left to Claude Code)'}`);
			return decision;
		},
		onPostEdit: (input: HookInput) => {
			log(`Claude finished ${input.tool_name}: ${input.tool_input?.file_path}`);
			const root = workspaceRootFor(input.cwd);
			if (root) {
				const file = path.relative(root, input.tool_input?.file_path ?? '');
				const watching = state?.mode === 'watch';
				state?.addActivity(watching ? 'watched' : 'applied', file);
				const record = recorder.after(input, root, state?.mode ?? 'review');
				if (watching && record && state?.followLive) {
					// Watching live: play the change instead of just flashing it.
					replayer.live(record.id);
				} else {
					stage.materialize(input, root).catch(err => log(`Could not highlight the finished edit: ${err}`));
				}
			}
		},
		onControl: (action: string, text?: string) => {
			if (action === 'mode' && (text === 'watch' || text === 'review') && state) {
				state.mode = text;
				log(`Mode set to ${text} from outside VS Code`);
				return;
			}
			const command = { pause: 'glassbox.pauseClaude', resume: 'glassbox.resumeClaude', stop: 'glassbox.stopClaude', send: 'glassbox.tellClaude' }[action];
			if (command) {
				log(`Control from outside VS Code: ${action}`);
				vscode.commands.executeCommand(command, ...(action === 'send' ? [text ?? ''] : []));
			}
		},
		onPrompt: (input: HookInput) => {
			if (workspaceRootFor(input.cwd)) {
				log(`Claude got a new request: ${(input.prompt ?? '').slice(0, 80)}`);
				watch.promptSubmitted(input.prompt);
			}
		},
		onTurnEnd: (input: HookInput) => {
			if (workspaceRootFor(input.cwd)) {
				log('Claude finished its turn');
				watch.turnEnded();
			}
		},
		log,
		info: () => ({ folders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [], live: watch.view(approvals.pendingEdit?.file), mode: state?.mode, recentLog }),
	});

	const preferredPort = vscode.workspace.getConfiguration('glassbox').get<number>('port', DEFAULT_PORT);
	try {
		const port = await server.start(preferredPort);
		log(`Listening on http://127.0.0.1:${port}`);
		showLiveStatus(status, watch.view(approvals.pendingEdit?.file), port);
		status.show();
	} catch (err) {
		log(`Could not start server: ${err}`);
		vscode.window.showErrorMessage(`Glassbox could not start: ${err}`);
		return;
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('glassbox.connect', connectCommand),
		vscode.commands.registerCommand('glassbox.disconnect', disconnectCommand),
		vscode.commands.registerCommand('glassbox.showLog', () => output.show()),
		{ dispose: () => server?.stop() },
	);

	// If this project was connected earlier but on a different port, fix the hooks quietly.
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (root && server.port && hooks.isConnected(root)) {
		hooks.connect(root, server.port);
		log(`Updated Claude Code hooks in ${hooks.settingsPath(root)}`);
	}
	state.setConnection(!!root && hooks.isConnected(root), server.port);
}

async function connectCommand() {
	const root = await pickWorkspaceFolder();
	if (!root || !server?.port) {
		return;
	}
	try {
		const file = hooks.connect(root, server.port);
		state?.setConnection(true, server.port);
		vscode.window.showInformationMessage(
			`Glassbox connected to Claude Code (${path.relative(root, file)}). Restart Claude Code in this project so it picks up the hooks.`,
		);
	} catch (err) {
		vscode.window.showErrorMessage(`Glassbox: ${err instanceof Error ? err.message : err}`);
	}
}

async function disconnectCommand() {
	const root = await pickWorkspaceFolder();
	if (!root) {
		return;
	}
	const removed = hooks.disconnect(root);
	state?.setConnection(false, server?.port);
	vscode.window.showInformationMessage(
		removed ? 'Glassbox disconnected from Claude Code in this project.' : 'Glassbox was not connected in this project.',
	);
}

async function pickWorkspaceFolder(): Promise<string | undefined> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		vscode.window.showWarningMessage('Glassbox: open a project folder first.');
		return undefined;
	}
	if (folders.length === 1) {
		return folders[0].uri.fsPath;
	}
	const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Connect Glassbox to which folder?' });
	return picked?.uri.fsPath;
}

// Finds the open workspace folder that contains Claude Code's working directory.
function workspaceRootFor(cwd: string | undefined): string | undefined {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (!cwd) {
		return folders[0]?.uri.fsPath;
	}
	const normalized = path.resolve(cwd).toLowerCase();
	return folders
		.map(f => f.uri.fsPath)
		.find(root => {
			const r = path.resolve(root).toLowerCase();
			return normalized === r || normalized.startsWith(r + path.sep);
		});
}

// Shows Claude's state in the status bar: yellow when paused, red when stopped.
function showLiveStatus(status: vscode.StatusBarItem, view: LiveView, port: number | undefined): void {
	switch (view.phase) {
		case 'paused':
			status.text = '$(debug-pause) Claude PAUSED';
			status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			status.command = 'glassbox.resumeClaude';
			status.tooltip = `${view.detail ?? ''}\nClick to resume.`;
			break;
		case 'waiting':
			status.text = '$(bell) Claude waiting for you';
			status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			status.command = 'glassbox.panel.focus';
			status.tooltip = view.detail;
			break;
		case 'stopped':
			status.text = '$(debug-stop) Claude STOPPED';
			status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
			status.command = 'glassbox.panel.focus';
			status.tooltip = view.detail;
			break;
		case 'working':
			status.text = '$(sync~spin) Claude working';
			status.backgroundColor = undefined;
			status.command = 'glassbox.pauseClaude';
			status.tooltip = `${view.detail ?? ''}\nClick to pause.`;
			break;
		default:
			status.text = `$(eye) Glassbox${port ? ` :${port}` : ''}`;
			status.backgroundColor = undefined;
			status.command = 'glassbox.panel.focus';
			status.tooltip = 'Glassbox is watching. Claude is idle.';
	}
}

// Called when VS Code shuts down or the extension is disabled.
export function deactivate() {
	server?.stop();
}
