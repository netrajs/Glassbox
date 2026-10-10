import * as http from 'http';
import { Decision, HookInput } from './types';

// Plain Node (no `vscode` import) so it can be tested outside VS Code.

export const DEFAULT_PORT = 7337;
const PORT_ATTEMPTS = 10;
// Claude Code kills the hook after its timeout (600s in our config).
// Answer a little earlier so Claude falls back cleanly instead of erroring.
const DECISION_TIMEOUT_MS = 580_000;

export interface ServerHandlers {
	onPreEdit(input: HookInput): Promise<Decision>;
	onPostEdit(input: HookInput): void;
	// The user sent Claude a request, or Claude finished its turn.
	onPrompt(input: HookInput): void;
	onTurnEnd(input: HookInput): void;
	onControl?(action: string, text?: string): void;
	// Handles any request outside /glassbox/ (Glassbox Web serves its page here). Returns true if handled.
	serve?(req: http.IncomingMessage, res: http.ServerResponse): boolean;
	log(message: string): void;
	// Extra details included in the health check, useful for debugging.
	info?(): object;
}

export class GlassboxServer {
	private server?: http.Server;
	port?: number;

	constructor(private readonly handlers: ServerHandlers) {}

	// Listens on the first free port starting at `preferredPort`.
	async start(preferredPort = DEFAULT_PORT): Promise<number> {
		for (let port = preferredPort; port < preferredPort + PORT_ATTEMPTS; port++) {
			try {
				await this.listen(port);
				this.port = port;
				return port;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
					throw err;
				}
			}
		}
		throw new Error(`No free port between ${preferredPort} and ${preferredPort + PORT_ATTEMPTS - 1}`);
	}

	stop(): void {
		this.server?.close();
		this.server = undefined;
	}

	private listen(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => this.handle(req, res));
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => {
				server.off('error', reject);
				this.server = server;
				resolve();
			});
		});
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const send = (status: number, body: unknown) => {
			res.writeHead(status, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(body));
		};

		if (!req.url?.startsWith('/glassbox/') && this.handlers.serve?.(req, res)) {
			return;
		}
		if (req.method === 'GET' && req.url === '/glassbox/health') {
			return send(200, { ok: true, name: 'glassbox', ...this.handlers.info?.() });
		}
		if (req.method !== 'POST') {
			return send(404, {});
		}

		let input: HookInput;
		try {
			input = JSON.parse(await readBody(req));
		} catch {
			this.handlers.log('Received a hook call with invalid JSON, ignoring it.');
			return send(200, {});
		}

		if (req.url === '/glassbox/pre') {
			try {
				const decision = await withTimeout(this.handlers.onPreEdit(input), DECISION_TIMEOUT_MS);
				return send(200, toHookOutput(decision));
			} catch (err) {
				this.handlers.log(`Error while handling an edit: ${err}`);
				return send(200, {});
			}
		}
		if (req.url === '/glassbox/post') {
			this.handlers.onPostEdit(input);
			return send(200, {});
		}
		if (req.url === '/glassbox/control') {
			// Pause / resume / stop / send from outside VS Code (used for testing).
			const body = input as { action?: string; text?: string };
			this.handlers.onControl?.(body.action ?? '', body.text);
			return send(200, { ok: true, ...this.handlers.info?.() });
		}
		if (req.url === '/glassbox/prompt') {
			this.handlers.onPrompt(input);
			return send(200, {});
		}
		if (req.url === '/glassbox/stop') {
			this.handlers.onTurnEnd(input);
			return send(200, {});
		}
		send(404, {});
	}
}

// Converts a decision into the JSON format Claude Code expects from a PreToolUse hook.
// An empty object means "no opinion": Claude Code continues as if Glassbox wasn't there.
export function toHookOutput(decision: Decision): object {
	if (!decision) {
		return {};
	}
	if (decision.kind === 'stop') {
		// `continue: false` makes Claude Code end the turn; `stopReason` is shown to the user.
		return { continue: false, stopReason: decision.reason };
	}
	if (decision.kind === 'allow') {
		return {
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'allow',
				permissionDecisionReason: 'Approved in Glassbox',
			},
		};
	}
	return {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: decision.reason,
		},
	};
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		promise.then(
			value => { clearTimeout(timer); resolve(value); },
			err => { clearTimeout(timer); reject(err); },
		);
	});
}
