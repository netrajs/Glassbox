import Anthropic from '@anthropic-ai/sdk';
import { Explanation } from '../panel/protocol';
import { EditPlan } from '../stage/editPlan';
import { EditContext } from './transcript';

// Turns a pending edit into a short plain-English explanation using the Claude API.

const MAX_LINES = 200;

const SYSTEM = `You explain code changes that an AI coding agent is about to make, to the developer who owns the code.
The developer may be new to coding. Write plain English, avoid jargon, and never invent details that are not in the change.

Return:
- summary: one short sentence (max 15 words) saying what the change does.
- steps: 1 to 3 short bullet points describing the change, in order, each under 20 words.
- why: one or two sentences on why the agent is making this change, based on the user's request and the agent's own words.`;

const SCHEMA = {
	type: 'object',
	properties: {
		summary: { type: 'string' },
		steps: { type: 'array', items: { type: 'string' } },
		why: { type: 'string' },
	},
	required: ['summary', 'steps', 'why'],
	additionalProperties: false,
};

export interface ExplainInput {
	file: string;
	tool: string;
	plan: EditPlan;
	context: EditContext;
}

export async function explainEdit(apiKey: string, model: string, input: ExplainInput, signal?: AbortSignal): Promise<Explanation> {
	const client = new Anthropic({ apiKey });
	const response = await client.beta.messages.create(
		{
			model,
			max_tokens: 2000,
			betas: ['server-side-fallback-2026-07-01'],
			fallbacks: 'default',
			// Explanations should feel instant: keep thinking light.
			output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
			system: SYSTEM,
			messages: [{ role: 'user', content: describe(input) }],
		},
		{ signal },
	);

	if (response.stop_reason === 'refusal') {
		throw new Error('Claude declined to explain this change.');
	}
	const text = response.content.find(block => block.type === 'text');
	if (!text || text.type !== 'text') {
		throw new Error('The explanation came back empty.');
	}
	const parsed = JSON.parse(text.text) as { summary: string; steps: string[]; why: string };
	return { status: 'ready', source: 'ai', summary: parsed.summary, steps: parsed.steps.slice(0, 3), why: parsed.why };
}

const ASK_SYSTEM = `You answer a developer's question about one code change an AI coding agent made in their project.
The developer may be new to coding. Answer in plain English in at most 5 short sentences, referring to the actual code.
If the change doesn't contain enough information to answer, say so honestly.`;

export async function askAboutEdit(apiKey: string, model: string, input: ExplainInput, question: string): Promise<string> {
	const client = new Anthropic({ apiKey });
	const response = await client.beta.messages.create({
		model,
		max_tokens: 4000,
		betas: ['server-side-fallback-2026-07-01'],
		fallbacks: 'default',
		output_config: { effort: 'low' },
		system: ASK_SYSTEM,
		messages: [{ role: 'user', content: `${describe(input)}\n\nThe developer asks: ${question}` }],
	});
	if (response.stop_reason === 'refusal') {
		throw new Error('Claude declined to answer this question.');
	}
	const text = response.content
		.filter(block => block.type === 'text')
		.map(block => (block.type === 'text' ? block.text : ''))
		.join('\n')
		.trim();
	if (!text) {
		throw new Error('The answer came back empty.');
	}
	return text;
}

const QUIZ_SYSTEM = `You write one quick multiple-choice question that checks whether a developer understands a code change an AI coding agent made in their project.
The developer may be new to coding. Ask about what the change does or why, not trivia like variable names.
Give exactly 3 short options with one clearly correct answer, and a one-sentence explanation of the right answer.`;

const QUIZ_SCHEMA = {
	type: 'object',
	properties: {
		question: { type: 'string' },
		options: { type: 'array', items: { type: 'string' } },
		answer: { type: 'integer', description: 'Index (0-2) of the correct option' },
		why: { type: 'string' },
	},
	required: ['question', 'options', 'answer', 'why'],
	additionalProperties: false,
};

export interface Quiz {
	question: string;
	options: string[];
	answer: number;
	why: string;
}

export async function quizAboutEdit(apiKey: string, model: string, input: ExplainInput): Promise<Quiz> {
	const client = new Anthropic({ apiKey });
	const response = await client.beta.messages.create({
		model,
		max_tokens: 2000,
		betas: ['server-side-fallback-2026-07-01'],
		fallbacks: 'default',
		output_config: { effort: 'low', format: { type: 'json_schema', schema: QUIZ_SCHEMA } },
		system: QUIZ_SYSTEM,
		messages: [{ role: 'user', content: describe(input) }],
	});
	if (response.stop_reason === 'refusal') {
		throw new Error('Claude declined to write a quiz for this change.');
	}
	const text = response.content.find(block => block.type === 'text');
	if (!text || text.type !== 'text') {
		throw new Error('The quiz came back empty.');
	}
	const quiz = JSON.parse(text.text) as Quiz;
	if (quiz.options.length < 2 || quiz.answer < 0 || quiz.answer >= quiz.options.length) {
		throw new Error('The quiz came back malformed.');
	}
	return quiz;
}

// Fallback when there's no API key: show what Claude itself said before the edit.
export function explanationFromTranscript(context: EditContext): Explanation {
	if (!context.reasoning) {
		return { status: 'none' };
	}
	return { status: 'ready', source: 'claude', why: context.reasoning };
}

function describe({ file, tool, plan, context }: ExplainInput): string {
	const lines = (list: string[], sign: string) =>
		list.length === 0
			? '(none)'
			: list
				.slice(0, MAX_LINES)
				.map(l => `${sign} ${l}`)
				.join('\n') + (list.length > MAX_LINES ? `\n… ${list.length - MAX_LINES} more lines` : '');

	return [
		`File: ${file}`,
		`Action: ${tool === 'Write' ? 'write the whole file' : 'edit part of the file'}`,
		`The user asked the agent: ${context.request ?? '(unknown)'}`,
		`What the agent said before this change: ${context.reasoning ?? '(nothing)'}`,
		'',
		'Unchanged code just above the change:',
		plan.before.slice(-8).join('\n') || '(start of file)',
		'',
		'Lines being removed:',
		lines(plan.removed, '-'),
		'',
		'Lines being added:',
		lines(plan.added, '+'),
	].join('\n');
}
