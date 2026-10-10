import { BlindSpots } from '../timeline/blindspots';
import { Replayer } from '../timeline/replayer';
import { ChangeRecord } from '../timeline/store';
import { WatchController } from '../watch';
import { Insights } from './insights';
import { BlindSpotsState, TimelineSession, WatchState } from './protocol';

// Turns Glassbox's internal state into what the panel shows.
// Shared by the VS Code panel and Glassbox Web so both look and behave the same.

// How many removed / added lines each timeline entry previews.
const PREVIEW_LINES = 8;

// Groups recorded changes by Claude session, newest session first.
export function buildTimeline(records: readonly ChangeRecord[], insights: Insights): TimelineSession[] {
	const sessions = new Map<string, ChangeRecord[]>();
	for (const record of records) {
		const list = sessions.get(record.sessionId) ?? [];
		list.push(record);
		sessions.set(record.sessionId, list);
	}
	return [...sessions.entries()]
		.map(([id, list]) => {
			const first = new Date(list[0].time);
			return {
				id,
				started: first.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
				day: first.toLocaleDateString([], { month: 'short', day: 'numeric' }),
				entries: list.map(r => ({
					id: r.id,
					time: new Date(r.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
					file: r.file,
					summary: r.explanation?.summary,
					removedCount: r.plan.removed.length,
					addedCount: r.plan.added.length,
					mode: r.mode,
					request: r.request,
					explanation: r.explanation,
					explaining: insights.isExplaining(r.id),
					qa: r.qa ?? [],
					removed: r.plan.removed.slice(0, PREVIEW_LINES),
					added: r.plan.added.slice(0, PREVIEW_LINES),
					reviewed: !!r.reviewed,
					quiz: insights.quizState(r.id),
				})),
				last: new Date(list[list.length - 1].time).getTime(),
			};
		})
		.sort((a, b) => b.last - a.last)
		.map(({ last: _last, ...session }) => session);
}

export function buildWatch(watch: WatchController, replayer: Replayer, awaitingApproval: string | undefined, followLive: boolean): WatchState {
	return {
		...watch.view(awaitingApproval),
		status: watch.status,
		request: watch.request,
		lastStep: watch.lastStep,
		pausing: watch.pauseRequestedFlag && !watch.heldStep,
		heldStep: watch.heldStep,
		stopPending: watch.pendingStop,
		notice: watch.notice,
		messagesQueued: watch.queuedMessages,
		followLive,
		behind: replayer.liveBehind,
		playbackPaused: replayer.playbackPaused,
	};
}

export function buildBlindSpots(spots: BlindSpots): BlindSpotsState {
	return {
		aiLines: spots.aiLines,
		reviewedLines: spots.reviewedLines,
		files: spots.files.map(f => ({
			file: f.file,
			aiLines: f.aiLines,
			reviewedLines: f.reviewedLines,
			unreviewedChanges: f.unreviewedIds.length,
		})),
	};
}
