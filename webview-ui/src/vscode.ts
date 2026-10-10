import type { PanelState, ToExtension } from '../../src/panel/protocol';

// The same panel runs in two places:
// - inside VS Code (a webview, talking to the extension through acquireVsCodeApi), and
// - in a normal browser tab for Glassbox Web (talking to the local server over HTTP).

interface VsCodeApi {
	postMessage(message: ToExtension): void;
	getState(): unknown;
	setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export const isWeb = typeof acquireVsCodeApi !== 'function';

const vscodeApi: VsCodeApi | undefined = isWeb ? undefined : acquireVsCodeApi();

export function send(message: ToExtension): void {
	if (vscodeApi) {
		vscodeApi.postMessage(message);
		return;
	}
	fetch('/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) }).catch(() => undefined);
}

// Calls `onState` with every new state. Returns a function that stops listening.
export function subscribe(onState: (state: PanelState) => void): () => void {
	if (isWeb) {
		const events = new EventSource('/events');
		events.onmessage = event => onState(JSON.parse(event.data) as PanelState);
		return () => events.close();
	}
	const onMessage = (event: MessageEvent<{ type: string; state: PanelState }>) => {
		if (event.data?.type === 'state') {
			onState(event.data.state);
		}
	};
	window.addEventListener('message', onMessage);
	send({ type: 'ready' });
	return () => window.removeEventListener('message', onMessage);
}

// Small per-panel preferences (like the voice toggle) that survive reloads.
type Prefs = { voice?: boolean };

export function loadPrefs(): Prefs {
	if (vscodeApi) {
		return (vscodeApi.getState() as Prefs) ?? {};
	}
	try {
		return JSON.parse(localStorage.getItem('glassbox.prefs') ?? '{}') as Prefs;
	} catch {
		return {};
	}
}

export function savePrefs(prefs: Prefs): void {
	if (vscodeApi) {
		vscodeApi.setState(prefs);
		return;
	}
	try {
		localStorage.setItem('glassbox.prefs', JSON.stringify(prefs));
	} catch {
		// Preferences are a convenience; ignore storage errors.
	}
}
