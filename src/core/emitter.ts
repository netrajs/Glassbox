// A tiny event emitter shaped like VS Code's, so core logic runs both inside the
// extension and in the standalone Glassbox Web server (no `vscode` import).

export interface Disposable {
	dispose(): void;
}

export type Event<T> = (listener: (value: T) => void) => Disposable;

export class Emitter<T = void> {
	private readonly listeners = new Set<(value: T) => void>();

	readonly event: Event<T> = listener => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};

	fire(value: T): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(value);
			} catch (err) {
				console.error('Glassbox event listener failed', err);
			}
		}
	}
}
