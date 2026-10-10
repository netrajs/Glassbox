import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Insights } from '../panel/insights';
import { Activity, Mode, PanelState, ToExtension } from '../panel/protocol';
import { buildBlindSpots, buildTimeline, buildWatch } from '../panel/stateBuilder';
import { GlassboxServer } from '../server';
import { BlindSpots, computeBlindSpots } from '../timeline/blindspots';
import { Recorder } from '../timeline/recorder';
import { Replayer } from '../timeline/replayer';
import { TimelineStore } from '../timeline/store';
import { EDIT_TOOLS, HookInput } from '../types';
import { WatchController } from '../watch';
import { WebExplainer } from './explainCore';
import { WebApprovals } from './webApprovals';
import { WebStageHost } from './webStage';

// Glassbox Web: everything the VS Code extension does, served to a browser tab instead.
// Uses the same core (watch controls, timeline, blind spots, explanations) and the same panel UI.

const MAX_ACTIVITY = 25;

export class WebSession {
	readonly server: GlassboxServer;
	private readonly stage = new WebStageHost();
	private readonly watch = new WatchController();
	private readonly timeline: TimelineStore;
	private readonly recorder: Recorder;
	private readonly replayer: Replayer;
	private readonly approvals: WebApprovals;
	private readonly insights: Insights;
	private readonly explainer: WebExplainer;
	private mode: Mode = 'review';
	private followLive = true;
	private activity: Activity[] = [];
	private nextActivityId = 1;
	private blindSpots: BlindSpots = { files: [], aiLines: 0, reviewedLines: 0 };
	private readonly clients = new Set<http.ServerResponse>();
	private pushTimer?: NodeJS.Timeout;

	constructor(
		private readonly root: string,
		private readonly uiDir: string,
		apiKey: string | undefined,
		model: string,
		private readonly log: (message: string) => void,
	) {
		this.timeline = new TimelineStore(storageDir(root));
		this.explainer = new WebExplainer(apiKey, model);
		this.recorder = new Recorder(this.timeline, this.explainer);
		this.replayer = new Replayer(this.stage, this.timeline, message => this.log(message));
		this.approvals = new WebApprovals(root, this.stage, this.explainer);
		this.insights = new Insights(this.timeline, this.explainer);

		for (const source of [this.stage, this.watch, this.timeline, this.replayer, this.approvals, this.insights]) {
			source.onDidChange(() => this.push());
		}
		this.timeline.onDidChange(() => this.recomputeBlindSpots());
		this.recomputeBlindSpots();

		this.approvals.onDidDecide(({ file, decision, input, explanation, request }) => {
			if (decision?.kind === 'allow') {
				this.addActivity('approved', file);
				this.recorder.rememberReview(input, root, { explanation, request });
			} else if (decision?.kind === 'deny') {
				this.addActivity('redirected', file, decision.reason.replace(/^.*wants something different: /, ''));
			}
		});

		this.server = new GlassboxServer({
			onPreEdit: input => this.onPreTool(input),
			onPostEdit: input => this.onPostEdit(input),
			onPrompt: input => this.belongsHere(input) && this.watch.promptSubmitted(input.prompt),
			onTurnEnd: input => this.belongsHere(input) && this.watch.turnEnded(),
			onControl: (action, text) => this.handle(controlToMessage(action, text)),
			serve: (req, res) => this.serve(req, res),
			log,
			info: () => ({ project: root, live: this.watch.view(this.approvals.pendingEdit?.file), mode: this.mode }),
		});
	}

	private belongsHere(input: HookInput): boolean {
		if (!input.cwd) {
			return true;
		}
		const cwd = path.resolve(input.cwd).toLowerCase();
		const root = path.resolve(this.root).toLowerCase();
		return cwd === root || cwd.startsWith(root + path.sep);
	}

	private async onPreTool(input: HookInput) {
		if (!this.belongsHere(input)) {
			return undefined;
		}
		const control = await this.watch.gate(input, this.root);
		if (control) {
			this.log(`Control on ${input.tool_name}: ${control.kind}`);
			return control;
		}
		if (!EDIT_TOOLS.has(input.tool_name ?? '')) {
			return undefined;
		}
		this.recorder.before(input, this.root);
		if (this.mode === 'watch') {
			return undefined;
		}
		this.log(`Claude wants to ${input.tool_name}: ${input.tool_input?.file_path}`);
		return this.approvals.ask(input);
	}

	private onPostEdit(input: HookInput): void {
		if (!this.belongsHere(input)) {
			return;
		}
		const record = this.recorder.after(input, this.root, this.mode);
		if (record) {
			this.addActivity(this.mode === 'watch' ? 'watched' : 'applied', record.file);
			if (this.mode === 'watch' && this.followLive) {
				this.replayer.live(record.id);
			}
		}
	}

	private handle(message: ToExtension | undefined): void {
		if (!message) {
			return;
		}
		switch (message.type) {
			case 'ready':
				return this.push();
			case 'approve':
				return this.approvals.approve();
			case 'approveAll':
				return this.approvals.approveAll();
			case 'redirect':
				return this.approvals.redirect(message.text);
			case 'replay':
				return this.approvals.replay();
			case 'setMode':
				this.mode = message.mode;
				return this.push();
			case 'replayChange':
			case 'openChange':
				// The browser has no editor to open, so "open" replays the change in the code view.
				this.replayer.replay(message.id);
				return;
			case 'replaySession':
				this.replayer.replaySession(message.sessionId);
				return;
			case 'stopTour':
				return this.replayer.stopTour();
			case 'clearTimeline':
				return this.timeline.clear();
			case 'pauseClaude':
				this.watch.pause();
				return this.replayer.pausePlayback();
			case 'resumeClaude':
				this.watch.resume();
				return this.replayer.resumePlayback();
			case 'stopClaude':
				this.watch.stop();
				return this.replayer.stopPlayback();
			case 'tellClaude':
				this.watch.send(message.text);
				return this.replayer.resumePlayback();
			case 'setFollowLive':
				this.followLive = message.value;
				return this.push();
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
				const spot = this.blindSpots.files.find(f => f.file === message.file);
				if (spot && spot.unreviewedIds.length > 0) {
					this.replayer.replayMany(spot.unreviewedIds, `file:${message.file}`);
				}
				return;
			}
			case 'markUnderstood':
				return this.insights.markFileUnderstood(message.file);
			case 'stageDone':
				return this.stage.done(message.key);
			case 'connect':
			case 'setApiKey':
				// Handled from the command line in Glassbox Web.
				return;
		}
	}

	private state(): PanelState {
		const pending = this.approvals.pendingEdit;
		return {
			connected: true,
			port: this.server.port,
			mode: this.mode,
			pending,
			queued: this.approvals.queued,
			activity: this.activity,
			timeline: buildTimeline(this.timeline.all, this.insights),
			tour: this.replayer.tour,
			watch: buildWatch(this.watch, this.replayer, pending?.file, this.followLive),
			hasApiKey: this.explainer.hasApiKey,
			blindSpots: buildBlindSpots(this.blindSpots),
			web: { project: this.root, stage: this.stage.stage },
		};
	}

	// Sends the latest state to every open browser tab (batched to one update per tick).
	private push(): void {
		if (this.pushTimer) {
			return;
		}
		this.pushTimer = setTimeout(() => {
			this.pushTimer = undefined;
			const data = `data: ${JSON.stringify(this.state())}\n\n`;
			for (const client of this.clients) {
				client.write(data);
			}
		}, 0);
	}

	private addActivity(kind: Activity['kind'], file: string, detail?: string): void {
		const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		this.activity = [{ id: this.nextActivityId++, time, kind, file, detail }, ...this.activity].slice(0, MAX_ACTIVITY);
		this.push();
	}

	private recomputeBlindSpots(): void {
		this.blindSpots = computeBlindSpots(this.timeline.all, file => {
			try {
				return fs.readFileSync(path.join(this.root, file), 'utf8');
			} catch {
				return undefined;
			}
		});
		this.push();
	}

	// The page, its assets, the live state stream (Server-Sent Events) and user actions.
	private serve(req: http.IncomingMessage, res: http.ServerResponse): boolean {
		const url = (req.url ?? '/').split('?')[0];
		if (req.method === 'GET' && url === '/events') {
			res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
			res.write(`data: ${JSON.stringify(this.state())}\n\n`);
			this.clients.add(res);
			req.on('close', () => this.clients.delete(res));
			return true;
		}
		if (req.method === 'POST' && url === '/action') {
			let body = '';
			req.on('data', chunk => (body += chunk));
			req.on('end', () => {
				try {
					this.handle(JSON.parse(body) as ToExtension);
				} catch {
					// Ignore malformed actions.
				}
				res.writeHead(204);
				res.end();
			});
			return true;
		}
		if (req.method === 'GET') {
			const assets: Record<string, [string, string]> = {
				'/': ['index.html', 'text/html; charset=utf-8'],
				'/index.js': ['index.js', 'text/javascript; charset=utf-8'],
				'/index.css': ['index.css', 'text/css; charset=utf-8'],
			};
			const asset = assets[url];
			if (!asset) {
				return false;
			}
			const [name, type] = asset;
			const content = name === 'index.html' ? PAGE : readAsset(this.uiDir, name);
			if (content === undefined) {
				res.writeHead(500, { 'Content-Type': 'text/plain' });
				res.end(`Glassbox Web: missing ${name}. Run "npm run compile" first.`);
				return true;
			}
			res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
			res.end(content);
			return true;
		}
		return false;
	}
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Glassbox</title>
	<link rel="stylesheet" href="/index.css">
</head>
<body class="glassbox-web">
	<div id="root"></div>
	<script type="module" src="/index.js"></script>
</body>
</html>`;

function readAsset(dir: string, name: string): string | undefined {
	try {
		return fs.readFileSync(path.join(dir, name), 'utf8');
	} catch {
		return undefined;
	}
}

// Timeline storage outside the project, so nothing is added to the user's repo.
function storageDir(root: string): string {
	const safe = path.resolve(root).replace(/[:\\/]+/g, '_').replace(/^_+/, '');
	return path.join(os.homedir(), '.glassbox', 'projects', safe);
}

// Lets the /glassbox/control test endpoint drive the same actions as the browser buttons.
function controlToMessage(action: string, text?: string): ToExtension | undefined {
	switch (action) {
		case 'pause':
			return { type: 'pauseClaude' };
		case 'resume':
			return { type: 'resumeClaude' };
		case 'stop':
			return { type: 'stopClaude' };
		case 'send':
			return { type: 'tellClaude', text: text ?? '' };
		case 'mode':
			return text === 'watch' || text === 'review' ? { type: 'setMode', mode: text } : undefined;
		case 'approve':
			return { type: 'approve' };
		default:
			return undefined;
	}
}
