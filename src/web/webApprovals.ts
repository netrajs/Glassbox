import * as fs from 'fs';
import * as path from 'path';
import { Emitter } from '../core/emitter';
import { Explanation, PendingEdit } from '../panel/protocol';
import { planEdit } from '../stage/editPlan';
import { Presentation } from '../stage/presentation';
import { Decision, HookInput } from '../types';
import { WebExplainer } from './explainCore';
import { WebStageHost } from './webStage';

// Review mode for Glassbox Web: each edit Claude wants to make waits here until the user
// approves or redirects it in the browser. Same behaviour as the extension's Approvals.

const DECISION_TIMEOUT_MS = 570_000;

interface Pending {
	id: number;
	input: HookInput;
	file: string;
	presentation?: Presentation;
	explanation: Explanation;
	request?: string;
	resolve(decision: Decision): void;
}

export interface WebDecision {
	file: string;
	decision: Decision;
	input: HookInput;
	explanation?: Explanation;
	request?: string;
}

export class WebApprovals {
	private queue: Promise<unknown> = Promise.resolve();
	private current?: Pending;
	private waiting = 0;
	private approvingAll = false;
	private nextId = 1;
	private readonly changed = new Emitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly decided = new Emitter<WebDecision>();
	readonly onDidDecide = this.decided.event;

	constructor(
		private readonly root: string,
		private readonly stage: WebStageHost,
		private readonly explainer: WebExplainer,
	) {}

	ask(input: HookInput): Promise<Decision> {
		this.waiting++;
		this.changed.fire();
		const next = this.queue.then(() => this.show(input));
		this.queue = next.catch(() => undefined);
		return next.finally(() => {
			this.waiting--;
			if (this.waiting === 0) {
				this.approvingAll = false;
			}
			this.changed.fire();
		});
	}

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
			file: p.file,
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
		);
	}

	replay(): void {
		this.current?.presentation?.replay();
	}

	private async show(input: HookInput): Promise<Decision> {
		const file = relativePath(input, this.root);
		if (this.approvingAll) {
			this.decided.fire({ file, decision: { kind: 'allow' }, input });
			return { kind: 'allow' };
		}
		const decision = new Promise<Decision>(resolve => {
			this.current = { id: this.nextId++, input, file, explanation: { status: 'loading' }, resolve };
		});
		const pending = this.current!;
		const timer = setTimeout(() => this.decide(undefined), DECISION_TIMEOUT_MS);

		const absolute = path.join(this.root, file);
		const original = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : undefined;
		const presentation = await this.stage.show(planEdit(input, original), path.basename(file));
		pending.presentation = presentation;
		presentation.replay();
		this.changed.fire();

		this.explainer
			.explain(input, presentation.plan, file)
			.then(({ explanation, request }) => {
				if (this.current === pending) {
					pending.explanation = explanation;
					pending.request = request;
					this.changed.fire();
				}
			})
			.catch(() => undefined);

		const result = await decision;
		clearTimeout(timer);
		return result;
	}

	private decide(decision: Decision): void {
		const pending = this.current;
		if (!pending) {
			return;
		}
		this.current = undefined;
		pending.presentation?.finish();
		pending.resolve(decision);
		this.decided.fire({ file: pending.file, decision, input: pending.input, explanation: pending.explanation, request: pending.request });
		this.changed.fire();
	}
}

function relativePath(input: HookInput, root: string): string {
	const file = input.tool_input?.file_path ?? 'unknown file';
	return path.isAbsolute(file) ? path.relative(root, file) : file;
}
