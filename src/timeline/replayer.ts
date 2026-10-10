import * as path from 'path';
import { Emitter } from '../core/emitter';
import { Presentation, PresentationHost } from '../stage/presentation';
import { TimelineStore } from './store';

// Replays recorded changes: one at a time, or a whole Claude session as a guided tour.

const PAUSE_BETWEEN_MS = 1500;

export interface TourState {
	sessionId: string;
	index: number;
	total: number;
	// The change currently on screen.
	currentId: number;
}

export class Replayer {
	private current?: Presentation;
	private tourRun = 0;
	private liveQueue: number[] = [];
	private livePlaying = false;
	private paused = false;
	tour?: TourState;
	private readonly changed = new Emitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(
		private readonly stage: PresentationHost,
		private readonly store: TimelineStore,
		// Shows a short confirmation to the user (the status bar in VS Code).
		private readonly notify: (message: string) => void = () => undefined,
	) {}

	async replay(id: number): Promise<void> {
		this.stopTour();
		this.liveQueue = [];
		this.paused = false;
		await this.play(id, 1, 'replay', true);
	}

	// Watching live: plays each new change as it lands, one after another.
	// When Claude gets ahead, later changes play faster so the view catches up.
	live(id: number): void {
		if (this.tour) {
			return;
		}
		this.liveQueue.push(id);
		this.changed.fire();
		if (!this.livePlaying) {
			this.drainLive();
		}
	}

	// Changes Claude already made that haven't been shown yet.
	get liveBehind(): number {
		return this.liveQueue.length;
	}

	get playbackPaused(): boolean {
		return this.paused;
	}

	// Freezes playback exactly where it is.
	pausePlayback(): void {
		this.paused = true;
		this.current?.pause();
		this.changed.fire();
	}

	resumePlayback(): void {
		this.paused = false;
		this.current?.resume();
		this.changed.fire();
	}

	// Jumps the current change to its final view and drops anything still waiting to play.
	stopPlayback(): void {
		this.liveQueue = [];
		this.paused = false;
		this.current?.finish();
		this.stopTour();
		this.changed.fire();
	}

	private async drainLive(): Promise<void> {
		this.livePlaying = true;
		try {
			while (this.liveQueue.length > 0 && !this.tour) {
				const id = this.liveQueue.shift()!;
				const speed = this.liveQueue.length >= 3 ? 4 : this.liveQueue.length >= 1 ? 2 : 1;
				this.changed.fire();
				await this.play(id, speed, 'live');
			}
		} finally {
			this.livePlaying = false;
		}
	}

	async replaySession(sessionId: string): Promise<void> {
		await this.replayMany(this.store.bySession(sessionId).map(r => r.id), sessionId);
	}

	// Plays several changes one after another as a guided tour (a session, or a file's blind spots).
	async replayMany(ids: number[], tourKey: string): Promise<void> {
		this.stopTour();
		this.liveQueue = [];
		this.paused = false;
		const run = ++this.tourRun;
		for (let i = 0; i < ids.length; i++) {
			if (run !== this.tourRun) {
				return;
			}
			this.tour = { sessionId: tourKey, index: i, total: ids.length, currentId: ids[i] };
			this.changed.fire();
			await this.play(ids[i], 1, 'replay', true);
			await new Promise(resolve => setTimeout(resolve, PAUSE_BETWEEN_MS));
		}
		if (run === this.tourRun) {
			this.tour = undefined;
			this.changed.fire();
			this.notify(`Replayed ${ids.length} change${ids.length === 1 ? '' : 's'}`);
		}
	}

	stopTour(): void {
		this.tourRun++;
		if (this.tour) {
			this.tour = undefined;
			this.current?.dispose();
			this.current = undefined;
			this.changed.fire();
		}
	}

	// `deliberate`: the user chose to watch this change, so it counts as reviewed (live playback doesn't).
	private async play(id: number, speed = 1, label = 'replay', deliberate = false): Promise<void> {
		const record = this.store.get(id);
		if (!record) {
			return;
		}
		if (deliberate) {
			this.store.markReviewed([id]);
		}
		this.current?.dispose();
		this.current = await this.stage.show(record.plan, `${path.basename(record.file)} (${label})`);
		if (this.paused) {
			this.current.pause();
		}
		await this.current.replay(speed);
	}
}
