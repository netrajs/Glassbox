import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HookInput } from '../types';
import { Presentation, PresentationHost } from './presentation';
import { EditPlan, erasingLength, findAll, Frame, frame, normalizeEol, planEdit, typingLength } from './editPlan';

// The Stage shows an edit before it happens, in one easy-to-read view of the file:
// unchanged code, then the lines Claude removes (red, −), then the lines it adds (green, +),
// with the new lines typing themselves in. After Claude applies it, the new code flashes green.

export const PREVIEW_SCHEME = 'glassbox-preview';

// The animation: show the old code in red for HIGHLIGHT_MS, erase it (at most ERASE_MAX_MS),
// pause for GAP_MS, then type the new code (about 30 characters a second, at most TYPING_MAX_MS).
const TICK_MS = 33;
const HIGHLIGHT_MS = 1500;
const ERASE_MAX_MS = 1500;
const GAP_MS = 300;
// Pause after typing before the BEFORE / AFTER review view appears.
const SETTLE_MS = 700;
const TYPING_MAX_MS = 6000;
const MATERIALIZE_MS = 2000;

// VS Code's own diff colours, so it matches every theme.
const removedLine = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
	textDecoration: 'line-through',
	opacity: '0.8',
	before: { contentText: '−', color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'), width: '1.5em', fontWeight: 'bold' },
	overviewRulerColor: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
	overviewRulerLane: vscode.OverviewRulerLane.Full,
});

const addedLine = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
	before: { contentText: '+', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'), width: '1.5em', fontWeight: 'bold' },
	overviewRulerColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
	overviewRulerLane: vscode.OverviewRulerLane.Full,
});

// Unchanged lines get the same indent as − / + lines so the code stays aligned.
const unchangedLine = vscode.window.createTextEditorDecorationType({
	before: { contentText: '', width: '1.5em' },
});

const label = (text: string, color: string) =>
	vscode.window.createTextEditorDecorationType({
		after: { contentText: text, color: new vscode.ThemeColor(color), fontStyle: 'italic', margin: '0 0 0 2em' },
	});
const removedLabel = label('← BEFORE: Claude removes this', 'gitDecoration.deletedResourceForeground');
const addedLabel = label('← AFTER: Claude writes this instead', 'gitDecoration.addedResourceForeground');

const materializeStyle = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
	after: { contentText: '✔ applied', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'), fontStyle: 'italic', margin: '0 0 0 2em' },
});

// Highlights a past change when it is opened from the timeline.
const REVEAL_MS = 3000;
const revealStyle = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
	border: '1px solid',
	borderColor: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
});
const revealLabel = vscode.window.createTextEditorDecorationType({
	after: { contentText: '← this change', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'), fontStyle: 'italic', margin: '0 0 0 2em' },
});

// Serves the contents of the virtual preview documents.
export class PreviewProvider implements vscode.TextDocumentContentProvider {
	private readonly contents = new Map<string, string>();
	private readonly changed = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.changed.event;

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? '';
	}

	set(uri: vscode.Uri, content: string): void {
		this.contents.set(uri.toString(), content);
		this.changed.fire(uri);
	}

	delete(uri: vscode.Uri): void {
		this.contents.delete(uri.toString());
	}
}

// A preview in the VS Code editor; the buttons appear in its virtual document.
export interface StagePresentation extends Presentation {
	previewUri: vscode.Uri;
}

export class Stage implements PresentationHost {
	private counter = 0;

	constructor(private readonly preview: PreviewProvider) {}

	// Shows an edit Claude is about to make.
	async present(input: HookInput, root: string): Promise<StagePresentation> {
		const filePath = resolvePath(input.tool_input?.file_path ?? '', root);
		const exists = fs.existsSync(filePath);
		const original = exists ? (await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))).getText() : undefined;
		const presentation = await this.show(planEdit(input, original), path.basename(filePath));
		presentation.replay();
		return presentation;
	}

	// Opens a preview of `plan`. Call `replay()` to play the animation.
	async show(plan: EditPlan, name: string): Promise<StagePresentation> {
		const previewUri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${++this.counter}/${name}` });
		let latest = frame(plan, 0, 0);
		this.preview.set(previewUri, latest.text);

		const editor = await vscode.window.showTextDocument(previewUri, { preview: true, viewColumn: vscode.ViewColumn.One });
		const focusLine = Math.max(0, plan.before.length - 2);
		editor.revealRange(new vscode.Range(focusLine, 0, focusLine, 0), vscode.TextEditorRevealType.InCenter);

		// Decorations must be re-applied every time the preview text changes.
		const onChange = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() === previewUri.toString()) {
				decorate(editor, latest);
			}
		});
		decorate(editor, latest);

		const render = (f: Frame) => {
			latest = f;
			this.preview.set(previewUri, f.text);
		};
		let animation: Animation | undefined;
		let paused = false;

		return {
			previewUri,
			buttonLine: Math.max(0, plan.before.length),
			plan,
			replay: async (speed = 1) => {
				animation?.finish();
				await vscode.window.showTextDocument(previewUri, { preview: true, viewColumn: vscode.ViewColumn.One });
				const current = new Animation(plan, render, speed);
				animation = current;
				if (paused) {
					current.pause();
				}
				await current.done;
			},
			pause: () => {
				paused = true;
				animation?.pause();
			},
			resume: () => {
				paused = false;
				animation?.resume();
			},
			finish: () => animation?.finish(),
			dispose: () => {
				animation?.cancel();
				onChange.dispose();
				closeTabs(previewUri);
				this.preview.delete(previewUri);
			},
		};
	}

	// Opens the real file at a recorded change and highlights that code.
	// Returns false if the code has changed since (the file opens near where it was).
	async revealChange(filePath: string, plan: EditPlan): Promise<boolean> {
		if (!fs.existsSync(filePath)) {
			vscode.window.showWarningMessage(`Glassbox: ${path.basename(filePath)} no longer exists.`);
			return false;
		}
		const editor = await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false, viewColumn: vscode.ViewColumn.One });
		const text = normalizeEol(editor.document.getText());
		const block = plan.added.join('\n');
		const index = block ? text.indexOf(block) : -1;

		if (index === -1) {
			// Deleted code, or edited since: go to roughly where the change was.
			const line = Math.min(plan.before.length, Math.max(0, editor.document.lineCount - 1));
			const position = new vscode.Position(line, 0);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
			vscode.window.setStatusBarMessage(
				block ? 'Glassbox: this code has changed since, showing where it was' : 'Glassbox: this change removed code, showing where it was',
				4000,
			);
			return false;
		}

		const startLine = lineOf(text, index);
		const range = new vscode.Range(startLine, 0, startLine + plan.added.length - 1, 0);
		editor.selection = new vscode.Selection(range.start, range.start);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
		const labelAt = editor.document.lineAt(startLine).range.end;
		editor.setDecorations(revealStyle, [range]);
		editor.setDecorations(revealLabel, [new vscode.Range(labelAt, labelAt)]);
		setTimeout(() => {
			editor.setDecorations(revealStyle, []);
			editor.setDecorations(revealLabel, []);
		}, REVEAL_MS);
		return true;
	}

	// Called after Claude applied an edit: show the real file with the new code flashing green.
	async materialize(input: HookInput, root: string): Promise<void> {
		const t = input.tool_input ?? {};
		const filePath = resolvePath(t.file_path ?? '', root);
		const newText = normalizeEol(t.new_string ?? t.content ?? '');
		if (!newText || !fs.existsSync(filePath)) {
			return;
		}
		const editor = await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false, viewColumn: vscode.ViewColumn.One });
		const text = normalizeEol(editor.document.getText());
		const ranges = findAll(text, newText, t.replace_all ?? false).map(
			i => new vscode.Range(lineOf(text, i), 0, lineOf(text, i + newText.trimEnd().length), 0),
		);
		if (ranges.length === 0) {
			return;
		}
		editor.setDecorations(materializeStyle, ranges);
		editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		setTimeout(() => editor.setDecorations(materializeStyle, []), MATERIALIZE_MS);
	}
}

// One run of the edit animation, driven by a timer that can be paused at any tick:
// 1. hold on the old code in red, 2. erase it (like backspacing), 3. short gap,
// 4. type the new code in green, 5. settle on BEFORE (red) above AFTER (green).
class Animation {
	readonly done: Promise<void>;
	private resolveDone!: () => void;
	private readonly timer: NodeJS.Timeout;
	private paused = false;
	private ended = false;

	constructor(
		private readonly plan: EditPlan,
		private readonly onFrame: (f: Frame) => void,
		speed: number,
	) {
		this.done = new Promise(resolve => (this.resolveDone = resolve));

		const eraseTotal = erasingLength(plan);
		const typeTotal = typingLength(plan);
		const ticks = (ms: number) => Math.max(1, Math.floor(ms / speed / TICK_MS));
		const erasePerTick = Math.max(1, Math.ceil(eraseTotal / ticks(ERASE_MAX_MS)), Math.round(speed));
		const typePerTick = Math.max(1, Math.ceil(typeTotal / ticks(TYPING_MAX_MS)), Math.round(speed));
		let holdTicks = eraseTotal > 0 ? ticks(HIGHLIGHT_MS) : 0;
		let erased = 0;
		let gapTicks = eraseTotal > 0 ? ticks(GAP_MS) : 0;
		let typed = 0;
		let settleTicks = eraseTotal > 0 ? ticks(SETTLE_MS) : 0;

		onFrame(frame(plan, 0, 0));
		this.timer = setInterval(() => {
			if (this.paused) {
				return;
			}
			if (holdTicks > 0) {
				holdTicks--;
				return;
			}
			if (erased < eraseTotal) {
				erased = Math.min(eraseTotal, erased + erasePerTick);
			} else if (gapTicks > 0) {
				gapTicks--;
				return;
			} else if (typed < typeTotal) {
				typed = Math.min(typeTotal, typed + typePerTick);
			} else if (settleTicks > 0) {
				settleTicks--;
				return;
			} else {
				this.finish();
				return;
			}
			onFrame(frame(plan, erased, typed));
			if (eraseTotal === 0 && typed >= typeTotal) {
				this.finish();
			}
		}, TICK_MS);
	}

	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
	}

	// Shows the final BEFORE / AFTER view and ends the animation.
	finish(): void {
		if (this.ended) {
			return;
		}
		this.onFrame(frame(this.plan, 0, typingLength(this.plan)));
		this.cancel();
	}

	cancel(): void {
		this.ended = true;
		clearInterval(this.timer);
		this.resolveDone();
	}
}

function decorate(editor: vscode.TextEditor, f: Frame): void {
	const lineCount = editor.document.lineCount;
	const lines = (from: number, to: number) => {
		const result: vscode.Range[] = [];
		for (let i = from; i < Math.min(to, lineCount); i++) {
			result.push(new vscode.Range(i, 0, i, 0));
		}
		return result;
	};
	const removed = lines(f.removed[0], f.removed[1]);
	const added = lines(f.added[0], f.added[1]);
	const changed = new Set([...removed, ...added].map(r => r.start.line));
	const unchanged = lines(0, lineCount).filter(r => !changed.has(r.start.line));

	editor.setDecorations(removedLine, removed);
	editor.setDecorations(addedLine, added);
	editor.setDecorations(unchangedLine, unchanged);
	editor.setDecorations(removedLabel, removed.length ? [endOfLine(editor, removed[0].start.line)] : []);
	editor.setDecorations(addedLabel, added.length ? [endOfLine(editor, added[0].start.line)] : []);
}

function endOfLine(editor: vscode.TextEditor, line: number): vscode.Range {
	const end = editor.document.lineAt(line).range.end;
	return new vscode.Range(end, end);
}

function lineOf(text: string, offset: number): number {
	return text.slice(0, offset).split('\n').length - 1;
}

function closeTabs(uri: vscode.Uri): void {
	const tabs = vscode.window.tabGroups.all
		.flatMap(group => group.tabs)
		.filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
	if (tabs.length > 0) {
		vscode.window.tabGroups.close(tabs);
	}
}

function resolvePath(file: string, root: string): string {
	return path.isAbsolute(file) ? path.normalize(file) : path.join(root, file);
}
