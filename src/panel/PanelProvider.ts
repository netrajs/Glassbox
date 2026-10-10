import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Approvals } from '../approval';
import { ExplainService } from '../explain/service';
import { GlassboxState } from '../state';
import { BlindSpotsService } from '../timeline/blindspotsService';
import { Replayer } from '../timeline/replayer';
import { TimelineStore } from '../timeline/store';
import { WatchController } from '../watch';
import { Insights } from './insights';
import { PanelState, ToExtension, ToPanel } from './protocol';
import { buildBlindSpots, buildTimeline, buildWatch } from './stateBuilder';

// The Glassbox side panel: a webview running the React app from webview-ui/dist.

export class PanelProvider implements vscode.WebviewViewProvider {
	static readonly viewId = 'glassbox.panel';
	private view?: vscode.WebviewView;
	private readonly insights: Insights;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly state: GlassboxState,
		private readonly approvals: Approvals,
		private readonly timeline: TimelineStore,
		private readonly replayer: Replayer,
		private readonly watch: WatchController,
		private readonly explainer: ExplainService,
		private readonly blindSpots: BlindSpotsService,
	) {
		this.insights = new Insights(timeline, explainer);
	}

	register(): vscode.Disposable {
		return vscode.Disposable.from(
			vscode.window.registerWebviewViewProvider(PanelProvider.viewId, this, { webviewOptions: { retainContextWhenHidden: true } }),
			this.watch.onDidChange(() => this.postState()),
			this.blindSpots.onDidChange(() => this.postState()),
			this.state.onDidChange(() => this.postState()),
			this.approvals.onDidChange(() => this.postState()),
			this.timeline.onDidChange(() => this.postState()),
			this.replayer.onDidChange(() => this.postState()),
			this.insights.onDidChange(() => this.postState()),
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const dist = vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
		view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
		view.webview.html = this.html(view.webview, dist);
		view.webview.onDidReceiveMessage((message: ToExtension) => this.handle(message));
		view.onDidDispose(() => (this.view = undefined));
	}

	// Brings the panel into view without stealing focus from the editor.
	async reveal(): Promise<void> {
		if (this.view) {
			this.view.show(true);
		} else {
			await vscode.commands.executeCommand(`${PanelProvider.viewId}.focus`);
		}
	}

	private handle(message: ToExtension): void {
		switch (message.type) {
			case 'ready':
				return this.postState();
			case 'approve':
				return this.approvals.approve();
			case 'approveAll':
				return this.approvals.approveAll();
			case 'redirect':
				return this.approvals.redirect(message.text);
			case 'replay':
				return this.approvals.replay();
			case 'setMode':
				this.state.mode = message.mode;
				return;
			case 'connect':
				vscode.commands.executeCommand('glassbox.connect');
				return;
			case 'setApiKey':
				vscode.commands.executeCommand('glassbox.setApiKey');
				return;
			case 'replayChange':
				this.replayer.replay(message.id);
				return;
			case 'openChange':
				vscode.commands.executeCommand('glassbox.openChange', message.id);
				return;
			case 'replaySession':
				this.replayer.replaySession(message.sessionId);
				return;
			case 'stopTour':
				return this.replayer.stopTour();
			case 'clearTimeline':
				vscode.window
					.showWarningMessage('Clear the Glassbox timeline for this project?', { modal: true }, 'Clear')
					.then(choice => choice === 'Clear' && this.timeline.clear());
				return;
			// Same commands as the status bar, so every Pause / Stop behaves identically.
			case 'pauseClaude':
				vscode.commands.executeCommand('glassbox.pauseClaude');
				return;
			case 'resumeClaude':
				vscode.commands.executeCommand('glassbox.resumeClaude');
				return;
			case 'stopClaude':
				vscode.commands.executeCommand('glassbox.stopClaude');
				return;
			case 'tellClaude':
				vscode.commands.executeCommand('glassbox.tellClaude', message.text);
				return;
			case 'setFollowLive':
				this.state.followLive = message.value;
				return;
			case 'explainChange':
				this.insights.explain(message.id);
				return;
			case 'askChange':
				this.insights.ask(message.id, message.question);
				return;
			case 'quizChange':
				this.insights.quiz(message.id);
				return;
			case 'answerQuiz':
				return this.insights.answer(message.id, message.choice);
			case 'walkthroughFile': {
				// Replays every unreviewed change in the file, oldest first.
				const spot = this.blindSpots.spotFor(message.file);
				if (spot && spot.unreviewedIds.length > 0) {
					this.replayer.replayMany(spot.unreviewedIds, `file:${message.file}`);
				}
				return;
			}
			case 'markUnderstood':
				return this.insights.markFileUnderstood(message.file);
			case 'stageDone':
				// Only used by Glassbox Web, where the browser plays the animation.
				return;
		}
	}

	private postState(): void {
		const pending = this.approvals.pendingEdit;
		const state: PanelState = {
			connected: this.state.connected,
			port: this.state.port,
			mode: this.state.mode,
			pending,
			queued: this.approvals.queued,
			activity: this.state.activity,
			timeline: buildTimeline(this.timeline.all, this.insights),
			tour: this.replayer.tour,
			watch: buildWatch(this.watch, this.replayer, pending?.file, this.state.followLive),
			hasApiKey: this.explainer.hasApiKey,
			blindSpots: buildBlindSpots(this.blindSpots.latest),
		};
		const message: ToPanel = { type: 'state', state };
		this.view?.webview.postMessage(message);
	}

	private html(webview: vscode.Webview, dist: vscode.Uri): string {
		const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'index.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'index.css'));
		const nonce = crypto.randomBytes(16).toString('base64');
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${style}">
	<title>Glassbox</title>
</head>
<body>
	<div id="root"></div>
	<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}
