import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BlindSpots, computeBlindSpots, FileSpot } from './blindspots';
import { TimelineStore } from './store';

// Keeps the Blind Spots map up to date and colours files in the Explorer:
// red = mostly unreviewed AI code, yellow = partly reviewed, green = reviewed.

const RECOMPUTE_DELAY_MS = 400;

export class BlindSpotsService implements vscode.FileDecorationProvider {
	latest: BlindSpots = { files: [], aiLines: 0, reviewedLines: 0 };
	private timer?: NodeJS.Timeout;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this.decorationsChanged.event;

	constructor(
		private readonly store: TimelineStore,
		private readonly root: () => string | undefined,
	) {}

	register(): vscode.Disposable {
		this.schedule();
		return vscode.Disposable.from(
			vscode.window.registerFileDecorationProvider(this),
			this.store.onDidChange(() => this.schedule()),
			vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()),
		);
	}

	spotFor(file: string): FileSpot | undefined {
		return this.latest.files.find(f => f.file === file);
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		const root = this.root();
		if (!root || uri.scheme !== 'file') {
			return undefined;
		}
		const spot = this.spotFor(path.relative(root, uri.fsPath));
		if (!spot) {
			return undefined;
		}
		const share = spot.reviewedLines / spot.aiLines;
		const unreviewed = spot.aiLines - spot.reviewedLines;
		return {
			badge: share >= 1 ? '✓' : 'AI',
			color: new vscode.ThemeColor(share >= 1 ? 'charts.green' : share >= 0.5 ? 'charts.yellow' : 'charts.red'),
			tooltip:
				unreviewed === 0
					? `Glassbox: you've reviewed all ${spot.aiLines} AI-written lines`
					: `Glassbox: ${unreviewed} of ${spot.aiLines} AI-written lines never reviewed`,
		};
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.recompute(), RECOMPUTE_DELAY_MS);
	}

	private recompute(): void {
		const root = this.root();
		if (!root) {
			return;
		}
		const before = new Set(this.latest.files.map(f => f.file));
		this.latest = computeBlindSpots(this.store.all, file => {
			try {
				return fs.readFileSync(path.join(root, file), 'utf8');
			} catch {
				return undefined;
			}
		});
		// Refresh files that gained or lost a badge.
		const touched = new Set([...before, ...this.latest.files.map(f => f.file)]);
		this.decorationsChanged.fire([...touched].map(f => vscode.Uri.file(path.join(root, f))));
		this.changed.fire();
	}
}
