import * as fs from 'fs';
import * as path from 'path';
import { readEditContext } from '../explain/transcript';
import { Explanation } from '../panel/protocol';
import { EditPlan, planFromTexts } from '../stage/editPlan';
import { HookInput } from '../types';
import { ChangeRecord, TimelineStore } from './store';

// Records each change: the file is snapshotted before Claude edits it (PreToolUse)
// and compared with the result afterwards (PostToolUse).

// What the recorder needs to explain changes (ExplainService in the extension).
export interface ChangeExplainer {
	readonly hasApiKey: boolean;
	explain(input: HookInput, plan: EditPlan, file: string): Promise<{ explanation: Explanation }>;
}

// How long after a Claude Code edit a file change is still considered Claude's,
// so the "other AI tools" watcher doesn't record it twice.
const CLAUDE_EDIT_WINDOW_MS = 5000;

export class Recorder {
	private readonly snapshots = new Map<string, string>();
	// Explanations already generated during review, so they aren't requested twice.
	private readonly reviewed = new Map<string, { explanation?: Explanation; request?: string }>();
	private readonly claudeTouched = new Map<string, number>();

	constructor(
		private readonly store: TimelineStore,
		private readonly explainer: ChangeExplainer,
	) {}

	before(input: HookInput, root: string): void {
		const file = absolute(input, root);
		this.claudeTouched.set(key(file), Date.now());
		this.snapshots.set(key(file), fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
	}

	rememberReview(input: HookInput, root: string, details: { explanation?: Explanation; request?: string }): void {
		this.reviewed.set(key(absolute(input, root)), details);
	}

	// True while Claude Code is (or just was) editing this file through the hooks.
	isClaudeEditing(file: string): boolean {
		const touched = this.claudeTouched.get(key(file));
		return touched !== undefined && Date.now() - touched < CLAUDE_EDIT_WINDOW_MS;
	}

	// Saves the change to the timeline and returns it (undefined if nothing changed).
	after(input: HookInput, root: string, mode: 'review' | 'watch'): ChangeRecord | undefined {
		const file = absolute(input, root);
		this.claudeTouched.set(key(file), Date.now());
		const before = this.snapshots.get(key(file));
		this.snapshots.delete(key(file));
		if (before === undefined || !fs.existsSync(file)) {
			return undefined;
		}
		const after = fs.readFileSync(file, 'utf8');
		const plan = planFromTexts(before, after);
		if (plan.removed.length === 0 && plan.added.length === 0) {
			return undefined;
		}

		const reviewed = this.reviewed.get(key(file));
		this.reviewed.delete(key(file));
		const explanation = reviewed?.explanation?.status === 'ready' ? reviewed.explanation : undefined;

		const record = this.store.add({
			time: new Date().toISOString(),
			sessionId: input.session_id ?? 'manual',
			file: path.relative(root, file),
			tool: input.tool_name ?? 'Edit',
			// An edit the user approved was reviewed, even if the mode changed since.
			mode: reviewed ? 'review' : mode,
			reviewed: !!reviewed,
			request: reviewed?.request ?? readEditContext(input.transcript_path).request,
			explanation,
			plan,
		});
		this.explainInBackground(record, input);
		return record;
	}

	// Records a change made by another AI tool (seen by watching files, not through hooks).
	external(file: string, root: string, before: string, after: string, sessionId: string): ChangeRecord | undefined {
		const plan = planFromTexts(before, after);
		if (plan.removed.length === 0 && plan.added.length === 0) {
			return undefined;
		}
		const record = this.store.add({
			time: new Date().toISOString(),
			sessionId,
			file: path.relative(root, file),
			tool: 'External',
			mode: 'watch',
			reviewed: false,
			plan,
		});
		this.explainInBackground(record, { tool_name: 'Edit', tool_input: { file_path: file } });
		return record;
	}

	// Changes that weren't reviewed with an explanation get one in the background.
	private explainInBackground(record: ChangeRecord, input: HookInput): void {
		if (record.explanation || !this.explainer.hasApiKey) {
			return;
		}
		this.explainer
			.explain(input, record.plan, record.file)
			.then(({ explanation }) => {
				if (explanation.status === 'ready') {
					this.store.update(record.id, { explanation });
				}
			})
			.catch(() => undefined);
	}
}

function absolute(input: HookInput, root: string): string {
	const file = input.tool_input?.file_path ?? '';
	return path.isAbsolute(file) ? path.normalize(file) : path.join(root, file);
}

// Windows paths are case-insensitive.
function key(file: string): string {
	return path.resolve(file).toLowerCase();
}
