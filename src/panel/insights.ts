import { Emitter } from '../core/emitter';
import { Quiz } from '../explain/explainer';
import { EditPlan } from '../stage/editPlan';
import { QA, TimelineStore } from '../timeline/store';
import { Explanation, QuizState } from './protocol';

// Explain / Ask / Quiz for recorded changes. Shared by the VS Code panel and Glassbox Web.
// Doing any of these counts as reviewing the change (for the Blind Spots map).

export interface InsightExplainer {
	readonly hasApiKey: boolean;
	explainRecorded(plan: EditPlan, file: string, tool: string, request?: string): Promise<Explanation>;
	ask(plan: EditPlan, file: string, tool: string, question: string, request?: string): Promise<string>;
	quiz(plan: EditPlan, file: string, tool: string, request?: string): Promise<Quiz>;
}

interface QuizEntry {
	quiz?: Quiz;
	chosen?: number;
	loading?: boolean;
	error?: string;
}

export class Insights {
	// Changes being explained right now, and quizzes (kept for this session only).
	private readonly explaining = new Set<number>();
	private readonly quizzes = new Map<number, QuizEntry>();
	private readonly changed = new Emitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(
		private readonly timeline: TimelineStore,
		private readonly explainer: InsightExplainer,
	) {}

	isExplaining(id: number): boolean {
		return this.explaining.has(id);
	}

	async explain(id: number): Promise<void> {
		const record = this.timeline.get(id);
		if (!record || this.explaining.has(id)) {
			return;
		}
		this.explaining.add(id);
		this.changed.fire();
		const explanation = await this.explainer.explainRecorded(record.plan, record.file, record.tool, record.request);
		this.explaining.delete(id);
		this.timeline.update(id, { explanation });
		this.timeline.markReviewed([id]);
	}

	async ask(id: number, question: string): Promise<void> {
		const record = this.timeline.get(id);
		const text = question.trim();
		if (!record || !text) {
			return;
		}
		this.timeline.markReviewed([id]);
		const entry: QA = { question: text };
		this.timeline.update(id, { qa: [...(record.qa ?? []), entry] });
		try {
			entry.answer = await this.explainer.ask(record.plan, record.file, record.tool, text, record.request);
		} catch (err) {
			entry.error = err instanceof Error ? err.message : String(err);
		}
		this.timeline.update(id, { qa: [...(this.timeline.get(id)?.qa ?? [])] });
	}

	async quiz(id: number): Promise<void> {
		const record = this.timeline.get(id);
		if (!record || this.quizzes.get(id)?.loading) {
			return;
		}
		this.quizzes.set(id, { loading: true });
		this.changed.fire();
		try {
			const quiz = await this.explainer.quiz(record.plan, record.file, record.tool, record.request);
			this.quizzes.set(id, { quiz });
		} catch (err) {
			this.quizzes.set(id, { error: err instanceof Error ? err.message : String(err) });
		}
		this.changed.fire();
	}

	answer(id: number, choice: number): void {
		const entry = this.quizzes.get(id);
		if (!entry?.quiz || entry.chosen !== undefined) {
			return;
		}
		entry.chosen = choice;
		// Getting it right shows understanding: the change is no longer a blind spot.
		if (choice === entry.quiz.answer) {
			this.timeline.markReviewed([id]);
		}
		this.changed.fire();
	}

	markFileUnderstood(file: string): void {
		this.timeline.markReviewed(this.timeline.all.filter(r => r.file === file).map(r => r.id));
	}

	quizState(id: number): QuizState | undefined {
		const entry = this.quizzes.get(id);
		if (!entry) {
			return undefined;
		}
		if (entry.loading) {
			return { status: 'loading' };
		}
		if (entry.error || !entry.quiz) {
			return { status: 'error', error: entry.error ?? 'Something went wrong.' };
		}
		const answered = entry.chosen !== undefined;
		return {
			status: 'ready',
			question: entry.quiz.question,
			options: entry.quiz.options,
			chosen: entry.chosen,
			answer: answered ? entry.quiz.answer : undefined,
			why: answered ? entry.quiz.why : undefined,
		};
	}
}
