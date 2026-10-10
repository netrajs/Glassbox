import * as path from 'path';
import { Decision, HookInput } from './types';
import { Emitter } from './core/emitter';

// Live controls over Claude: pause before its next step, stop it, or send it a message.
// Every tool call Claude makes passes through `gate()` before it runs.

export interface Step {
	text: string;
	time: string;
}

// The one state the user sees: what Claude is doing, in plain words.
export interface LiveView {
	phase: 'idle' | 'working' | 'paused' | 'stopped' | 'waiting';
	title: string;
	detail?: string;
}

// idle: not working on anything. working: busy with a request. stopped: ended by the user from Glassbox.
export type ClaudeStatus = 'idle' | 'working' | 'stopped';

export class WatchController {
	private pauseRequested = false;
	private stopRequested = false;
	private feedback: string[] = [];
	private held?: { step: string; resolve(decision: Decision): void };
	status: ClaudeStatus = 'idle';
	// The request Claude is working on (from the UserPromptSubmit hook).
	request?: string;
	lastStep?: Step;
	// A one-off confirmation shown to the user, e.g. "Message delivered to Claude".
	notice?: string;

	private readonly changed = new Emitter<void>();
	readonly onDidChange = this.changed.event;

	get pauseRequestedFlag(): boolean {
		return this.pauseRequested;
	}

	get heldStep(): string | undefined {
		return this.held?.step;
	}

	get pendingStop(): boolean {
		return this.stopRequested;
	}

	get queuedMessages(): number {
		return this.feedback.length;
	}

	// The user sent Claude a new request.
	promptSubmitted(prompt: string | undefined): void {
		this.status = 'working';
		this.request = prompt?.trim() || this.request;
		this.lastStep = undefined;
		this.stopRequested = false;
		this.notice = undefined;
		this.changed.fire();
	}

	// Claude finished its turn (or was stopped).
	turnEnded(): void {
		if (this.status !== 'stopped') {
			this.status = 'idle';
		}
		// Nothing left to pause or stop until the next request.
		this.stopRequested = false;
		this.release(undefined);
		this.changed.fire();
	}

	// Decides what happens to Claude's next step. undefined = carry on as normal.
	async gate(input: HookInput, root: string): Promise<Decision> {
		const step = describeStep(input, root);
		// A step after an earlier stop means Claude was given new work.
		if (!this.stopRequested) {
			this.status = 'working';
		}
		this.lastStep = { text: step, time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) };
		this.changed.fire();

		const now = this.takeControl();
		if (now) {
			return now;
		}
		if (!this.pauseRequested) {
			return undefined;
		}
		// Paused: hold this step until the user resumes, stops, or sends a message.
		return new Promise<Decision>(resolve => {
			this.held = { step, resolve };
			this.changed.fire();
		});
	}

	pause(): void {
		this.pauseRequested = true;
		this.notice = undefined;
		this.changed.fire();
	}

	resume(): void {
		this.pauseRequested = false;
		this.notice = undefined;
		this.release(undefined);
	}

	// Everything the panel and status bar show comes from here, so they always agree.
	// `awaitingApproval` is the file Claude is waiting for the user to approve (Review mode).
	view(awaitingApproval?: string): LiveView {
		if (awaitingApproval && this.status !== 'stopped') {
			return {
				phase: 'waiting',
				title: 'WAITING FOR YOU',
				detail: `Claude wants to change ${awaitingApproval}. Approve or redirect it below.`,
			};
		}
		if (this.status === 'stopped') {
			return {
				phase: 'stopped',
				title: 'STOPPED',
				detail: this.stopRequested
					? 'Claude will stop the moment it tries its next step.'
					: 'Claude has stopped. Send it a new request to continue.',
			};
		}
		if (this.held) {
			return { phase: 'paused', title: 'PAUSED', detail: `Claude is waiting. Its next step will be: ${this.held.step}` };
		}
		if (this.pauseRequested) {
			return {
				phase: 'paused',
				title: 'PAUSED',
				detail:
					this.status === 'working' && this.lastStep
						? `Claude is finishing “${this.lastStep.text}”, then it will wait.`
						: 'Claude will wait before its next step.',
			};
		}
		if (this.status === 'working') {
			return { phase: 'working', title: 'CLAUDE IS WORKING', detail: this.lastStep?.text ?? 'Starting…' };
		}
		return { phase: 'idle', title: 'CLAUDE IS IDLE', detail: 'Waiting for your next request.' };
	}

	stop(): void {
		this.pauseRequested = false;
		if (this.held) {
			this.status = 'stopped';
			this.notice = undefined;
			this.release(stopDecision());
		} else if (this.status === 'working') {
			// Shown as stopped right away; takes effect the moment Claude tries its next step.
			this.status = 'stopped';
			this.stopRequested = true;
			this.changed.fire();
		} else {
			this.notice = "Claude isn't working right now, so there's nothing to stop.";
			this.changed.fire();
		}
	}

	send(message: string): void {
		const text = message.trim();
		if (!text) {
			return;
		}
		this.feedback.push(text);
		if (this.held) {
			// Deliver right away and let Claude continue with the new instructions.
			this.pauseRequested = false;
			this.release(this.takeControl());
		} else {
			this.notice = this.status === 'working' ? undefined : "Claude isn't working right now. Your message will be delivered at its next step.";
			this.changed.fire();
		}
	}

	private takeControl(): Decision {
		if (this.stopRequested) {
			this.stopRequested = false;
			this.feedback = [];
			this.status = 'stopped';
			this.changed.fire();
			return stopDecision();
		}
		if (this.feedback.length > 0) {
			const messages = this.feedback.splice(0);
			this.notice = `Delivered to Claude: “${messages.join(' / ')}”`;
			this.changed.fire();
			return {
				kind: 'deny',
				reason:
					'The user is watching your work live in Glassbox and sent you this message, so this step was not run:\n' +
					messages.map(m => `- ${m}`).join('\n') +
					'\nTake it into account, then continue (retry this step only if it still makes sense).',
			};
		}
		return undefined;
	}

	private release(decision: Decision): void {
		const held = this.held;
		this.held = undefined;
		this.changed.fire();
		held?.resolve(decision);
	}
}

function stopDecision(): Decision {
	return { kind: 'stop', reason: 'Stopped from Glassbox.' };
}

// A short human description of a tool call, e.g. "Editing src/App.jsx" or "Running: npm test".
export function describeStep(input: HookInput, root: string): string {
	const t = input.tool_input ?? {};
	const file = t.file_path ? (path.isAbsolute(t.file_path) ? path.relative(root, t.file_path) : t.file_path) : '';
	switch (input.tool_name) {
		case 'Edit':
		case 'MultiEdit':
			return `Editing ${file}`;
		case 'Write':
			return `Writing ${file}`;
		case 'Read':
			return `Reading ${file}`;
		case 'Bash':
			return `Running: ${t.description || truncate(t.command ?? '', 80)}`;
		case 'Grep':
			return `Searching for "${truncate(t.pattern ?? '', 40)}"`;
		case 'Glob':
			return `Looking for files: ${t.pattern ?? ''}`;
		case 'WebFetch':
			return `Reading a web page: ${t.url ?? ''}`;
		case 'WebSearch':
			return 'Searching the web';
		case 'TodoWrite':
			return 'Updating its plan';
		case 'Task':
		case 'Agent':
			return `Starting a helper: ${t.description ?? ''}`;
		default:
			return `Using ${input.tool_name ?? 'a tool'}`;
	}
}

function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
