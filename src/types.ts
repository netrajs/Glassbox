// The JSON Claude Code sends to a hook on stdin (only the fields Glassbox uses).
export interface HookInput {
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	hook_event_name?: string;
	tool_name?: string;
	tool_input?: {
		file_path?: string;
		command?: string;
		pattern?: string;
		path?: string;
		url?: string;
		description?: string;
		old_string?: string;
		new_string?: string;
		replace_all?: boolean;
		content?: string;
		edits?: { old_string: string; new_string: string; replace_all?: boolean }[];
	};
	tool_response?: unknown;
	// UserPromptSubmit: what the user asked Claude.
	prompt?: string;
}

// What the user decided about Claude's next step.
// allow: go ahead. deny: don't do this step; `reason` is shown to Claude so it can adapt.
// stop: end Claude's turn. undefined: no opinion, Claude Code behaves normally.
export type Decision =
	| { kind: 'allow' }
	| { kind: 'deny'; reason: string }
	| { kind: 'stop'; reason: string }
	| undefined;

// The tools that change files; every other tool call only passes through Glassbox's controls.
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
