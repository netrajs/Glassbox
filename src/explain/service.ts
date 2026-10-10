import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { Explanation } from '../panel/protocol';
import { EditPlan } from '../stage/editPlan';
import { HookInput } from '../types';
import { askAboutEdit, explainEdit, explanationFromTranscript, Quiz, quizAboutEdit } from './explainer';
import { EditContext, readEditContext } from './transcript';

// Owns the API key (in VS Code's encrypted SecretStorage) and produces explanations.

const SECRET_KEY = 'glassbox.anthropicApiKey';

export interface ExplainResult {
	context: EditContext;
	explanation: Explanation;
}

export class ExplainService {
	hasApiKey = false;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeKey = this.changed.event;

	constructor(private readonly secrets: vscode.SecretStorage) {
		this.apiKey().then(key => (this.hasApiKey = !!key));
	}

	register(): vscode.Disposable {
		return vscode.Disposable.from(
			vscode.commands.registerCommand('glassbox.setApiKey', () => this.promptForKey()),
			vscode.commands.registerCommand('glassbox.clearApiKey', async () => {
				await this.secrets.delete(SECRET_KEY);
				this.hasApiKey = !!process.env.ANTHROPIC_API_KEY;
				this.changed.fire();
				vscode.window.showInformationMessage('Glassbox: API key removed.');
			}),
		);
	}

	async explain(input: HookInput, plan: EditPlan, file: string, signal?: AbortSignal): Promise<ExplainResult> {
		const context = readEditContext(input.transcript_path);
		const key = await this.apiKey();
		if (!key) {
			return { context, explanation: explanationFromTranscript(context) };
		}
		try {
			const explanation = await explainEdit(key, this.model(),{ file, tool: input.tool_name ?? 'Edit', plan, context }, signal);
			return { context, explanation };
		} catch (err) {
			if (signal?.aborted) {
				return { context, explanation: { status: 'none' } };
			}
			// Still show Claude's own words when the API call fails.
			const fallback = explanationFromTranscript(context);
			const error = describeError(err);
			return { context, explanation: fallback.status === 'ready' ? { ...fallback, error } : { status: 'error', error } };
		}
	}

	// Explains a change that already happened (from the timeline), using a stored request.
	async explainRecorded(plan: EditPlan, file: string, tool: string, request?: string): Promise<Explanation> {
		const key = await this.apiKey();
		if (!key) {
			return { status: 'error', error: 'Add an API key (Glassbox: Set API Key) to explain past changes.' };
		}
		try {
			return await explainEdit(key, this.model(), { file, tool, plan, context: { request } });
		} catch (err) {
			return { status: 'error', error: describeError(err) };
		}
	}

	// Answers a free-form question about a change.
	async ask(plan: EditPlan, file: string, tool: string, question: string, request?: string): Promise<string> {
		const key = await this.apiKey();
		if (!key) {
			throw new Error('Add an API key (Glassbox: Set API Key) to ask questions about changes.');
		}
		try {
			return await askAboutEdit(key, this.model(), { file, tool, plan, context: { request } }, question);
		} catch (err) {
			throw new Error(describeError(err));
		}
	}

	// A multiple-choice question that checks the user understands a change.
	async quiz(plan: EditPlan, file: string, tool: string, request?: string): Promise<Quiz> {
		const key = await this.apiKey();
		if (!key) {
			throw new Error('Add an API key (Glassbox: Set API Key) to get quizzed on changes.');
		}
		try {
			return await quizAboutEdit(key, this.model(), { file, tool, plan, context: { request } });
		} catch (err) {
			throw new Error(describeError(err));
		}
	}

	private model(): string {
		return vscode.workspace.getConfiguration('glassbox').get<string>('model', 'claude-opus-5-5');
	}

	private async apiKey(): Promise<string | undefined> {
		return (await this.secrets.get(SECRET_KEY)) || process.env.ANTHROPIC_API_KEY || undefined;
	}

	private async promptForKey(): Promise<void> {
		const key = await vscode.window.showInputBox({
			title: 'Glassbox: Anthropic API key',
			prompt: 'Used to explain each change in plain English. Stored encrypted in VS Code; never written to your project.',
			placeHolder: 'sk-ant-…',
			password: true,
			ignoreFocusOut: true,
		});
		if (!key?.trim()) {
			return;
		}
		await this.secrets.store(SECRET_KEY, key.trim());
		this.hasApiKey = true;
		this.changed.fire();
		vscode.window.showInformationMessage('Glassbox: API key saved. New changes will be explained.');
	}
}

function describeError(err: unknown): string {
	if (err instanceof Anthropic.AuthenticationError) {
		return 'Your API key was rejected. Run "Glassbox: Set API Key" to update it.';
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
