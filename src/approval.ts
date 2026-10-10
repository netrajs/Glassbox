import * as path from 'path';
import * as vscode from 'vscode';
import { ExplainService } from './explain/service';
import { Explanation, PendingEdit } from './panel/protocol';
import { PREVIEW_SCHEME, Stage, StagePresentation } from './stage/stage';
import { Decision, HookInput } from './types';

// The approval queue: shows each pending edit on the Stage and waits for Approve / Redirect,
// from the side panel, the buttons above the change, or the editor title bar.

// Answer before the server's own timeout so the Stage is always cleaned up.
const DECISION_TIMEOUT_MS = 570_000;

interface Pending {
	id: number;
	input: HookInput;
	relative: string;
	root: string;
	presentation?: StagePresentation;
	explanation: Explanation;
	request?: string;
	// Cancels the explanation request once the user decides.
	abort: AbortController;
	resolve(decision: Decision): void;
}

export interface DecisionEvent {
	file: string;
	decision: Decision;
	instruction?: string;
	input: HookInput;
	root: string;
	explanation?: Explanation;
	request?: string;
}

export class Approvals implements vscode.CodeLensProvider {
	private queue: Promise<unknown> = Promise.resolve();
	private current?: Pending;
	private waiting = 0;
	private approvingAll = false;
	private nextId = 1;

	private readonly changed = new vscode.EventEmitter<void>();
	// Fires whenever the pending edit or queue changes (refreshes CodeLens and the panel).
	readonly onDidChange = this.changed.event;
	readonly onDidChangeCodeLenses = this.changed.event;

	private readonly decided = new vscode.EventEmitter<DecisionEvent>();
	readonly onDidDecide = this.decided.event;

	constructor(
		private readonly stage: Stage,
		private readonly explainer: ExplainService,
	) {}

	register(): vscode.Disposable {
		return vscode.Disposable.from(
			vscode.languages.registerCodeLensProvider({ scheme: PREVIEW_SCHEME }, this),
			vscode.commands.registerCommand('glassbox.approve', () => this.approve()),
			vscode.commands.registerCommand('glassbox.redirect', () => this.promptRedirect()),
			vscode.commands.registerCommand('glassbox.replay', () => this.replay()),
		);
	}

	// Claude can request several edits at once; show them one at a time.
	ask(input: HookInput, root: string): Promise<Decision> {
		this.waiting++;
		this.changed.fire();
		const next = this.queue.then(() => this.show(input, root));
		this.queue = next.catch(() => undefined);
		return next.finally(() => {
			this.waiting--;
			if (this.waiting === 0) {
				this.approvingAll = false;
			}
			this.changed.fire();
		});
	}

	// Edits waiting behind the one currently shown.
	get queued(): number {
		return Math.max(0, this.waiting - (this.current ? 1 : 0));
	}

	get pendingEdit(): PendingEdit | undefined {
		const p = this.current;
		if (!p) {
			return undefined;
		}
		const plan = p.presentation?.plan;
		return {
			id: p.id,
			file: p.relative,
			tool: p.input.tool_name ?? 'Edit',
			request: p.request,
			explanation: p.explanation,
			hasApiKey: this.explainer.hasApiKey,
			removedCount: plan?.removed.length ?? 0,
			addedCount: plan?.added.length ?? 0,
			removed: plan?.removed ?? [],
			added: plan?.added ?? [],
			matched: plan?.matched ?? true,
		};
	}

	approve(): void {
		this.decide({ kind: 'allow' });
	}

	approveAll(): void {
		this.approvingAll = true;
		this.approve();
	}

	redirect(instruction: string): void {
		const text = instruction.trim();
		this.decide(
			text
				? { kind: 'deny', reason: `The user reviewed this edit in Glassbox and wants something different: ${text}` }
				: { kind: 'deny', reason: 'The user rejected this edit in Glassbox. Ask them what they would like instead.' },
			text,
		);
	}

	replay(): void {
		this.current?.presentation?.replay();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const p = this.current?.presentation;
		if (!p || document.uri.toString() !== p.previewUri.toString()) {
			return [];
		}
		const line = Math.min(p.buttonLine, Math.max(0, document.lineCount - 1));
		const range = new vscode.Range(line, 0, line, 0);
		return [
			new vscode.CodeLens(range, { title: '$(check) Approve', command: 'glassbox.approve' }),
			new vscode.CodeLens(range, { title: '$(reply) Redirect…', command: 'glassbox.redirect' }),
			new vscode.CodeLens(range, { title: '$(play) Replay', command: 'glassbox.replay' }),
		];
	}

	private async show(input: HookInput, root: string): Promise<Decision> {
		if (this.approvingAll) {
			const file = relativePath(input, root);
			this.decided.fire({ file, decision: { kind: 'allow' }, input, root });
			return { kind: 'allow' };
		}

		const decision = new Promise<Decision>(resolve => {
			this.current = {
				id: this.nextId++,
				input,
				relative: relativePath(input, root),
				root,
				explanation: { status: 'loading' },
				abort: new AbortController(),
				resolve,
			};
		});
		const pending = this.current!;
		// Shows the Approve / Redirect / Replay icons in the editor title bar.
		vscode.commands.executeCommand('setContext', 'glassbox.pending', true);
		this.changed.fire();
		const timer = setTimeout(() => this.decide(undefined), DECISION_TIMEOUT_MS);

		try {
			const presentation = await this.stage.present(input, root);
			if (this.current === pending) {
				pending.presentation = presentation;
				this.changed.fire();
				this.startExplanation(pending, presentation);
			} else {
				// Decided (or timed out) while the Stage was still opening.
				presentation.dispose();
			}
		} catch (err) {
			// The Stage is a nice-to-have: if it fails, the panel still lets the user decide.
			console.error('Glassbox stage failed', err);
		}

		const result = await decision;
		clearTimeout(timer);
		return result;
	}

	// Explains the edit in the background; the panel updates when it's ready.
	private startExplanation(pending: Pending, presentation: StagePresentation): void {
		this.explainer
			.explain(pending.input, presentation.plan, pending.relative, pending.abort.signal)
			.then(({ context, explanation }) => {
				if (this.current !== pending) {
					return;
				}
				pending.request = context.request;
				pending.explanation = explanation;
				this.changed.fire();
			})
			.catch(err => {
				if (this.current === pending) {
					pending.explanation = { status: 'error', error: String(err) };
					this.changed.fire();
				}
			});
	}

	private async promptRedirect(): Promise<void> {
		const pending = this.current;
		if (!pending) {
			return;
		}
		const instruction = await vscode.window.showInputBox({
			title: 'Glassbox: tell Claude what to do instead',
			prompt: `Instead of this change to ${pending.relative}…`,
			placeHolder: 'e.g. put the toggle button at the bottom of the sidebar',
			ignoreFocusOut: true,
		});
		if (instruction !== undefined && this.current === pending) {
			this.redirect(instruction);
		}
	}

	private decide(decision: Decision, instruction?: string): void {
		const pending = this.current;
		if (!pending) {
			return;
		}
		this.current = undefined;
		pending.abort.abort();
		vscode.commands.executeCommand('setContext', 'glassbox.pending', false);
		pending.presentation?.dispose();
		pending.resolve(decision);
		this.decided.fire({
			file: pending.relative,
			decision,
			instruction,
			input: pending.input,
			root: pending.root,
			explanation: pending.explanation,
			request: pending.request,
		});
		this.changed.fire();

		if (decision?.kind === 'allow') {
			vscode.window.setStatusBarMessage(`$(check) Glassbox: approved. Claude is applying the change to ${pending.relative}`, 5000);
		} else if (decision?.kind === 'deny') {
			vscode.window.setStatusBarMessage('$(reply) Glassbox: sent your instructions back to Claude', 5000);
		}
	}
}

function relativePath(input: HookInput, root: string): string {
	const file = input.tool_input?.file_path ?? 'unknown file';
	return path.isAbsolute(file) ? path.relative(root, file) : file;
}
