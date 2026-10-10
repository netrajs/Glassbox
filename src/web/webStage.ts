import { Emitter } from '../core/emitter';
import { WebStage } from '../panel/protocol';
import { EditPlan } from '../stage/editPlan';
import { Presentation, PresentationHost } from '../stage/presentation';

// Glassbox Web's "editor": the browser plays the animation; this tracks what it should
// show and waits for the browser to report back when an animation has finished.

// If the browser tab is closed, don't wait forever for it to say an animation finished.
const MAX_WAIT_MS = 20_000;

export class WebStageHost implements PresentationHost {
	stage?: WebStage;
	private nextKey = 1;
	private waiting = new Map<number, () => void>();
	private readonly changed = new Emitter<void>();
	readonly onDidChange = this.changed.event;

	// The browser finished animating `key`.
	done(key: number): void {
		this.waiting.get(key)?.();
	}

	async show(plan: EditPlan, name: string): Promise<Presentation> {
		let key = 0;
		const update = (changes: Partial<WebStage>) => {
			if (this.stage && this.stage.key === key) {
				this.stage = { ...this.stage, ...changes };
				this.changed.fire();
			}
		};
		const finishWaiting = () => {
			this.waiting.get(key)?.();
		};

		return {
			plan,
			buttonLine: plan.before.length,
			replay: (speed = 1) => {
				finishWaiting();
				key = this.nextKey++;
				this.stage = { key, label: name, plan, speed, paused: false, finished: false };
				this.changed.fire();
				return new Promise<void>(resolve => {
					const timer = setTimeout(() => resolve(), MAX_WAIT_MS / speed);
					this.waiting.set(key, () => {
						clearTimeout(timer);
						this.waiting.delete(key);
						resolve();
					});
				});
			},
			pause: () => update({ paused: true }),
			resume: () => update({ paused: false }),
			finish: () => {
				update({ finished: true, paused: false });
				finishWaiting();
			},
			dispose: finishWaiting,
		};
	}
}
