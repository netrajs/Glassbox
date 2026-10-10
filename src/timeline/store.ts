import * as fs from 'fs';
import * as path from 'path';
import { Explanation } from '../panel/protocol';
import { EditPlan } from '../stage/editPlan';
import { Emitter } from '../core/emitter';

// Every change Claude made, saved to the extension's storage so it survives restarts.

const MAX_RECORDS = 300;
// Keep stored context small: a few unchanged lines around each change is enough to replay it.
const CONTEXT_LINES = 40;
const SAVE_DELAY_MS = 500;

export interface ChangeRecord {
	id: number;
	// ISO timestamp.
	time: string;
	sessionId: string;
	file: string;
	tool: string;
	mode: 'review' | 'watch';
	request?: string;
	explanation?: Explanation;
	// Questions the user asked about this change, with answers.
	qa?: QA[];
	// True once the user has looked at this change (approved it, replayed it, opened it, asked about it…).
	reviewed?: boolean;
	plan: EditPlan;
}

export interface QA {
	question: string;
	answer?: string;
	error?: string;
}

export class TimelineStore {
	private records: ChangeRecord[] = [];
	private nextId = 1;
	private saveTimer?: NodeJS.Timeout;
	private readonly file: string;
	private readonly changed = new Emitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(storageDir: string) {
		this.file = path.join(storageDir, 'timeline.json');
		this.load();
	}

	get all(): readonly ChangeRecord[] {
		return this.records;
	}

	get(id: number): ChangeRecord | undefined {
		return this.records.find(r => r.id === id);
	}

	bySession(sessionId: string): ChangeRecord[] {
		return this.records.filter(r => r.sessionId === sessionId);
	}

	add(record: Omit<ChangeRecord, 'id'>): ChangeRecord {
		const saved: ChangeRecord = { ...record, id: this.nextId++, plan: trimContext(record.plan) };
		this.records = [...this.records, saved].slice(-MAX_RECORDS);
		this.changedAndSave();
		return saved;
	}

	update(id: number, changes: Partial<Pick<ChangeRecord, 'explanation' | 'request' | 'qa'>>): void {
		const record = this.get(id);
		if (record) {
			Object.assign(record, changes);
			this.changedAndSave();
		}
	}

	// Marks changes as looked at, for the Blind Spots map.
	markReviewed(ids: readonly number[]): void {
		let changed = false;
		for (const id of ids) {
			const record = this.get(id);
			if (record && !record.reviewed) {
				record.reviewed = true;
				changed = true;
			}
		}
		if (changed) {
			this.changedAndSave();
		}
	}

	clear(): void {
		this.records = [];
		this.changedAndSave();
	}

	private changedAndSave(): void {
		this.changed.fire();
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS);
	}

	private load(): void {
		try {
			const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ChangeRecord[];
			this.records = Array.isArray(data) ? data : [];
			this.nextId = Math.max(0, ...this.records.map(r => r.id)) + 1;
		} catch {
			this.records = [];
		}
	}

	private save(): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.writeFileSync(this.file, JSON.stringify(this.records), 'utf8');
		} catch (err) {
			console.error('Glassbox could not save the timeline', err);
		}
	}
}

function trimContext(plan: EditPlan): EditPlan {
	return { ...plan, before: plan.before.slice(-CONTEXT_LINES), after: plan.after.slice(0, CONTEXT_LINES) };
}
