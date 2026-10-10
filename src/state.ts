import * as vscode from 'vscode';
import { Activity, Mode } from './panel/protocol';

// Session-wide state shown in the side panel: mode, connection, recent activity.

const MAX_ACTIVITY = 25;
const MODE_KEY = 'glassbox.mode';
const FOLLOW_KEY = 'glassbox.followLive';

export class GlassboxState {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	connected = false;
	port?: number;
	activity: Activity[] = [];
	private nextId = 1;

	constructor(private readonly memento: vscode.Memento) {}

	get mode(): Mode {
		return this.memento.get<Mode>(MODE_KEY, 'review');
	}

	set mode(mode: Mode) {
		this.memento.update(MODE_KEY, mode);
		this.changed.fire();
	}

	// Watch mode: automatically play each change as it lands.
	get followLive(): boolean {
		return this.memento.get<boolean>(FOLLOW_KEY, true);
	}

	set followLive(value: boolean) {
		this.memento.update(FOLLOW_KEY, value);
		this.changed.fire();
	}

	setConnection(connected: boolean, port?: number): void {
		this.connected = connected;
		this.port = port;
		this.changed.fire();
	}

	addActivity(kind: Activity['kind'], file: string, detail?: string): void {
		const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		this.activity = [{ id: this.nextId++, time, kind, file, detail }, ...this.activity].slice(0, MAX_ACTIVITY);
		this.changed.fire();
	}

	// Lets other parts (like the approval queue) tell the panel to refresh.
	refresh(): void {
		this.changed.fire();
	}
}
