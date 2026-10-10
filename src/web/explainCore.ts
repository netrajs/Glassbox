import Anthropic from '@anthropic-ai/sdk';
import { askAboutEdit, explainEdit, explanationFromTranscript, Quiz, quizAboutEdit } from '../explain/explainer';
import { readEditContext } from '../explain/transcript';
import { InsightExplainer } from '../panel/insights';
import { Explanation } from '../panel/protocol';
import { EditPlan } from '../stage/editPlan';
import { ChangeExplainer } from '../timeline/recorder';
import { HookInput } from '../types';

// Explanations for Glassbox Web. The API key comes from the ANTHROPIC_API_KEY environment variable.

export class WebExplainer implements ChangeExplainer, InsightExplainer {
	constructor(
		private readonly apiKey: string | undefined,
		private readonly model: string,
	) {}

	get hasApiKey(): boolean {
		return !!this.apiKey;
	}

	// For an edit Claude is about to make (or just made).
	async explain(input: HookInput, plan: EditPlan, file: string): Promise<{ explanation: Explanation; request?: string }> {
		const context = readEditContext(input.transcript_path);
		if (!this.apiKey) {
			return { explanation: explanationFromTranscript(context), request: context.request };
		}
		try {
			const explanation = await explainEdit(this.apiKey, this.model, { file, tool: input.tool_name ?? 'Edit', plan, context });
			return { explanation, request: context.request };
		} catch (err) {
			const fallback = explanationFromTranscript(context);
			const error = describeError(err);
			return { explanation: fallback.status === 'ready' ? { ...fallback, error } : { status: 'error', error }, request: context.request };
		}
	}

	async explainRecorded(plan: EditPlan, file: string, tool: string, request?: string): Promise<Explanation> {
		if (!this.apiKey) {
			return { status: 'error', error: 'Set the ANTHROPIC_API_KEY environment variable to explain changes.' };
		}
		try {
			return await explainEdit(this.apiKey, this.model, { file, tool, plan, context: { request } });
		} catch (err) {
			return { status: 'error', error: describeError(err) };
		}
	}

	async ask(plan: EditPlan, file: string, tool: string, question: string, request?: string): Promise<string> {
		if (!this.apiKey) {
			throw new Error('Set the ANTHROPIC_API_KEY environment variable to ask questions about changes.');
		}
		try {
			return await askAboutEdit(this.apiKey, this.model, { file, tool, plan, context: { request } }, question);
		} catch (err) {
			throw new Error(describeError(err));
		}
	}

	async quiz(plan: EditPlan, file: string, tool: string, request?: string): Promise<Quiz> {
		if (!this.apiKey) {
			throw new Error('Set the ANTHROPIC_API_KEY environment variable to get quizzed on changes.');
		}
		try {
			return await quizAboutEdit(this.apiKey, this.model, { file, tool, plan, context: { request } });
		} catch (err) {
			throw new Error(describeError(err));
		}
	}
}

function describeError(err: unknown): string {
	if (err instanceof Anthropic.AuthenticationError) {
		return 'Your ANTHROPIC_API_KEY was rejected.';
	}
	if (err instanceof Anthropic.RateLimitError) {
		return 'Rate limited by the Claude API. Try again in a moment.';
	}
	if (err instanceof Anthropic.APIConnectionError) {
		return 'Could not reach the Claude API. Check your internet connection.';
	}
	if (err instanceof Anthropic.APIError) {
		return `Claude API error ${err.status ?? ''}: ${err.message}`;
	}
	return err instanceof Error ? err.message : String(err);
}
