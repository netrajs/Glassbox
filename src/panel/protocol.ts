// Messages between the extension and the side panel (webview).
// Imported by both sides, so keep it free of `vscode` and Node imports.

import type { EditPlan } from '../stage/editPlan';

export type Mode = 'review' | 'watch';

export interface Explanation {
	// loading: being generated; ready: shown; none: nothing to explain with; error: failed.
	status: 'loading' | 'ready' | 'none' | 'error';
	// 'ai' = generated explanation; 'claude' = Claude's own words from the transcript.
	source?: 'ai' | 'claude';
	summary?: string;
	steps?: string[];
	why?: string;
	error?: string;
}

export interface PendingEdit {
	id: number;
	file: string;
	tool: string;
	// What the user asked Claude, from the transcript.
	request?: string;
	explanation: Explanation;
	// False when no API key is set (the panel offers to add one).
	hasApiKey: boolean;
	removedCount: number;
	addedCount: number;
	// A short preview: removed lines, then added lines.
	removed: string[];
	added: string[];
	matched: boolean;
}

export interface Activity {
	id: number;
	time: string;
	kind: 'approved' | 'redirected' | 'applied' | 'watched' | 'skipped';
	file: string;
	detail?: string;
}

export interface TimelineEntry {
	id: number;
	time: string;
	file: string;
	summary?: string;
	removedCount: number;
	addedCount: number;
	mode: Mode;
	request?: string;
	explanation?: Explanation;
	// True while an explanation is being generated on request.
	explaining?: boolean;
	qa: { question: string; answer?: string; error?: string }[];
	// Short preview of the change: removed then added lines.
	removed: string[];
	added: string[];
	reviewed: boolean;
	quiz?: QuizState;
}

export type QuizState =
	| { status: 'loading' }
	| { status: 'error'; error: string }
	// `chosen` / `answer` / `why` are filled in once the user picks an option.
	| { status: 'ready'; question: string; options: string[]; chosen?: number; answer?: number; why?: string };

export interface BlindSpotFile {
	file: string;
	aiLines: number;
	reviewedLines: number;
	// Changes to this file still waiting to be reviewed.
	unreviewedChanges: number;
}

export interface BlindSpotsState {
	aiLines: number;
	reviewedLines: number;
	files: BlindSpotFile[];
}

export interface WatchState {
	// The single state shown to the user.
	phase: 'idle' | 'working' | 'paused' | 'stopped' | 'waiting';
	title: string;
	detail?: string;
	// idle: not working. working: busy with a request. stopped: ended from Glassbox.
	status: 'idle' | 'working' | 'stopped';
	// The request Claude is working on.
	request?: string;
	// Claude's most recent step, e.g. "Reading package.json".
	lastStep?: { text: string; time: string };
	// Pause was pressed but Claude is still finishing its current step.
	pausing: boolean;
	// The step Claude is held before while paused.
	heldStep?: string;
	stopPending: boolean;
	// A one-off confirmation, e.g. "Delivered to Claude: …".
	notice?: string;
	messagesQueued: number;
	followLive: boolean;
	// Live playback: changes Claude already made that haven't been shown yet.
	behind: number;
	playbackPaused: boolean;
}

export interface TimelineSession {
	id: string;
	// Time of the first change, e.g. "4:48 PM".
	started: string;
	day: string;
	entries: TimelineEntry[];
}

export interface Tour {
	sessionId: string;
	index: number;
	total: number;
	currentId: number;
}

export interface PanelState {
	connected: boolean;
	port?: number;
	mode: Mode;
	pending?: PendingEdit;
	// Edits waiting behind the current one.
	queued: number;
	activity: Activity[];
	// Newest session first.
	timeline: TimelineSession[];
	tour?: Tour;
	watch: WatchState;
	hasApiKey: boolean;
	blindSpots: BlindSpotsState;
	// Only set in Glassbox Web (the browser version), which has no VS Code editor.
	web?: WebInfo;
}

// What the browser's code view should show: an edit to animate.
export interface WebStage {
	// Changes every time a new animation should start.
	key: number;
	label: string;
	plan: EditPlan;
	speed: number;
	paused: boolean;
	// Jump straight to the final BEFORE / AFTER view.
	finished: boolean;
}

export interface WebInfo {
	project: string;
	stage?: WebStage;
}

export type ToExtension =
	| { type: 'ready' }
	| { type: 'approve' }
	| { type: 'approveAll' }
	| { type: 'redirect'; text: string }
	| { type: 'replay' }
	| { type: 'setMode'; mode: Mode }
	| { type: 'connect' }
	| { type: 'setApiKey' }
	| { type: 'replayChange'; id: number }
	| { type: 'openChange'; id: number }
	| { type: 'replaySession'; sessionId: string }
	| { type: 'stopTour' }
	| { type: 'clearTimeline' }
	| { type: 'pauseClaude' }
	| { type: 'resumeClaude' }
	| { type: 'stopClaude' }
	| { type: 'tellClaude'; text: string }
	| { type: 'setFollowLive'; value: boolean }
	| { type: 'explainChange'; id: number }
	| { type: 'askChange'; id: number; question: string }
	| { type: 'quizChange'; id: number }
	| { type: 'answerQuiz'; id: number; choice: number }
	| { type: 'walkthroughFile'; file: string }
	| { type: 'markUnderstood'; file: string }
	// Glassbox Web: the browser finished animating stage `key`.
	| { type: 'stageDone'; key: number };

export type ToPanel = { type: 'state'; state: PanelState };
