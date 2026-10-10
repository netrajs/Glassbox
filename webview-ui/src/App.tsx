import { useEffect, useState } from 'react';
import type { Activity, BlindSpotsState, Explanation, Mode, PanelState, PendingEdit, QuizState, TimelineEntry, TimelineSession, Tour, WatchState } from '../../src/panel/protocol';
import { CodeStage } from './CodeStage';
import { isWeb, loadPrefs, savePrefs, send, subscribe } from './vscode';
import { speak, stopSpeaking } from './voice';

const PREVIEW_LINES = 8;

export function App() {
	const [state, setState] = useState<PanelState | undefined>();
	const [tab, setTab] = useState<'timeline' | 'blindspots'>('timeline');
	const [voice, setVoice] = useState(() => !!loadPrefs().voice);
	const toggleVoice = () => {
		const next = !voice;
		setVoice(next);
		savePrefs({ ...loadPrefs(), voice: next });
		if (!next) {
			stopSpeaking();
		}
	};

	// Voice: read each new explanation aloud once it is ready.
	const pending = state?.pending;
	const readyText =
		pending?.explanation.status === 'ready' ? [pending.explanation.summary, pending.explanation.why].filter(Boolean).join('. ') : undefined;
	useEffect(() => {
		if (voice && readyText) {
			speak(readyText);
		}
	}, [voice, pending?.id, readyText]);

	useEffect(() => subscribe(setState), []);

	if (!state) {
		return <div className="empty">Loading…</div>;
	}

	const panel = (
		<div className="panel">
			<Header state={state} voice={voice} onToggleVoice={toggleVoice} />
			{!state.connected && <ConnectCard />}
			{state.tour && <TourBanner tour={state.tour} />}
			{state.connected && <LiveCard watch={state.watch} mode={state.mode} />}
			{state.pending ? <PendingCard pending={state.pending} queued={state.queued} /> : !state.connected && <Idle mode={state.mode} />}
			<div className="tabs" role="tablist">
				<button className={tab === 'timeline' ? 'active' : ''} onClick={() => setTab('timeline')}>
					Timeline
				</button>
				<button className={tab === 'blindspots' ? 'active' : ''} onClick={() => setTab('blindspots')}>
					Blind spots{state.blindSpots.aiLines > 0 && ` · ${unreviewedPercent(state.blindSpots)}% unreviewed`}
				</button>
			</div>
			{tab === 'timeline' ? (
				<Timeline sessions={state.timeline} tour={state.tour} hasApiKey={state.hasApiKey} voice={voice} />
			) : (
				<BlindSpots spots={state.blindSpots} />
			)}
			<ActivityFeed activity={state.activity} />
		</div>
	);

	if (!isWeb) {
		return panel;
	}
	// Glassbox Web: the code on the left (there is no VS Code editor), the panel on the right.
	return (
		<div className="web-layout">
			<main className="web-main">
				<div className="web-project" title={state.web?.project}>
					<span className="logo">◆</span> Glassbox Web · <span className="muted">{folderName(state.web?.project ?? '')}</span>
				</div>
				<CodeStage stage={state.web?.stage} />
			</main>
			<aside className="web-side">{panel}</aside>
		</div>
	);
}

function Header({ state, voice, onToggleVoice }: { state: PanelState; voice: boolean; onToggleVoice: () => void }) {
	const setMode = (mode: Mode) => send({ type: 'setMode', mode });
	return (
		<header className="header">
			<div className="brand">
				<span className="logo">◆</span> Glassbox
				<span className={`dot ${state.connected ? 'on' : ''}`} title={state.connected ? `Listening on port ${state.port}` : 'Not connected'} />
			</div>
			<button className={`icon-button ${voice ? 'active' : ''}`} onClick={onToggleVoice} title={voice ? 'Stop reading explanations aloud' : 'Read explanations aloud'}>
				{voice ? '🔊' : '🔈'}
			</button>
			<div className="mode" role="tablist">
				<button className={state.mode === 'review' ? 'active' : ''} onClick={() => setMode('review')} title="Claude pauses before each edit until you approve">
					Review
				</button>
				<button className={state.mode === 'watch' ? 'active' : ''} onClick={() => setMode('watch')} title="Claude edits freely; Glassbox shows each change as it lands">
					Watch
				</button>
			</div>
		</header>
	);
}

function ConnectCard() {
	return (
		<section className="card connect">
			<p>Claude Code isn't connected to this project yet.</p>
			<button className="primary" onClick={() => send({ type: 'connect' })}>
				Connect Claude Code
			</button>
		</section>
	);
}

function Idle({ mode }: { mode: Mode }) {
	return (
		<section className="card idle">
			<div className="idle-icon">◇</div>
			<p className="idle-title">Waiting for Claude</p>
			<p className="muted">
				{mode === 'review'
					? 'When Claude wants to change a file, it will pause and the change will appear here for you to approve.'
					: 'Watch mode: Claude edits freely and each change is highlighted as it lands.'}
			</p>
		</section>
	);
}

function PendingCard({ pending, queued }: { pending: PendingEdit; queued: number }) {
	const [text, setText] = useState('');
	useEffect(() => setText(''), [pending.id]);

	const redirect = () => {
		if (text.trim()) {
			send({ type: 'redirect', text: text.trim() });
		}
	};

	return (
		<section className="card pending" key={pending.id}>
			<div className="pending-top">
				<span className="badge">Claude wants to {pending.tool === 'Write' ? 'write' : 'edit'}</span>
				{queued > 0 && <span className="muted">1 of {queued + 1}</span>}
			</div>
			<div className="file" title={pending.file}>{pending.file}</div>
			<div className="counts">
				<span className="minus">−{pending.removedCount}</span>
				<span className="plus">+{pending.addedCount}</span>
				{!pending.matched && <span className="warn">couldn't find the old code in the file</span>}
			</div>

			{pending.request && <div className="request">You asked: “{truncate(pending.request, 160)}”</div>}
			<ExplanationView explanation={pending.explanation} hasApiKey={pending.hasApiKey} />

			<pre className="mini-diff">
				{pending.removed.slice(0, PREVIEW_LINES).map((line, i) => (
					<div key={`r${i}`} className="line removed"><span className="sign">−</span>{line || ' '}</div>
				))}
				{pending.removed.length > PREVIEW_LINES && <div className="line more">… {pending.removed.length - PREVIEW_LINES} more removed</div>}
				{pending.added.slice(0, PREVIEW_LINES).map((line, i) => (
					<div key={`a${i}`} className="line added"><span className="sign">+</span>{line || ' '}</div>
				))}
				{pending.added.length > PREVIEW_LINES && <div className="line more">… {pending.added.length - PREVIEW_LINES} more added</div>}
			</pre>

			<div className="actions">
				<button className="primary" onClick={() => send({ type: 'approve' })}>✔ Approve</button>
				<button onClick={() => send({ type: 'replay' })}>▶ Replay</button>
				{queued > 0 && <button onClick={() => send({ type: 'approveAll' })}>Approve all {queued + 1}</button>}
			</div>

			<div className="redirect">
				<label htmlFor="redirect">Want something different? Tell Claude:</label>
				<textarea
					id="redirect"
					rows={3}
					placeholder="e.g. put the button at the bottom instead"
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={e => {
						if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
							redirect();
						}
					}}
				/>
				<button disabled={!text.trim()} onClick={redirect}>↪ Redirect</button>
				<span className="hint">Ctrl+Enter to send</span>
			</div>
		</section>
	);
}

function ExplanationView({ explanation, hasApiKey }: { explanation: Explanation; hasApiKey: boolean }) {
	const addKey =
		!hasApiKey &&
		(isWeb ? (
			<p className="muted small">Start Glassbox with ANTHROPIC_API_KEY set for plain-English explanations.</p>
		) : (
			<button className="link" onClick={() => send({ type: 'setApiKey' })}>
				Add an API key for plain-English explanations
			</button>
		));

	switch (explanation.status) {
		case 'loading':
			return (
				<div className="explain loading" aria-busy="true">
					<div className="shimmer w80" />
					<div className="shimmer w60" />
					<span className="muted">Explaining this change…</span>
				</div>
			);
		case 'ready':
			if (explanation.source === 'claude') {
				return (
					<div className="explain">
						<div className="explain-label">Claude said</div>
						<p className="claude-words">{truncate(explanation.why ?? '', 600)}</p>
						{explanation.error && <p className="explain-error">{explanation.error}</p>}
						{addKey}
					</div>
				);
			}
			return (
				<div className="explain">
					<p className="summary">{explanation.summary}</p>
					{explanation.steps && explanation.steps.length > 0 && (
						<ol className="steps">
							{explanation.steps.map((s, i) => <li key={i}>{s}</li>)}
						</ol>
					)}
					{explanation.why && (
						<p className="why"><span className="explain-label">Why</span> {explanation.why}</p>
					)}
				</div>
			);
		case 'error':
			return (
				<div className="explain">
					<p className="explain-error">Couldn't explain this change: {explanation.error}</p>
				</div>
			);
		default:
			return addKey ? <div className="explain">{addKey}</div> : null;
	}
}

function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

const ACTIVITY_LABEL: Record<Activity['kind'], string> = {
	approved: '✔ Approved',
	redirected: '↪ Redirected',
	applied: '◆ Applied',
	watched: '◉ Changed',
	skipped: '– Skipped',
};

const PHASE_ICON: Record<WatchState['phase'], string> = {
	working: '●',
	paused: '⏸',
	stopped: '■',
	idle: '○',
	waiting: '●',
};

// One big banner saying what Claude is doing, two buttons, and a message box.
function LiveCard({ watch, mode }: { watch: WatchState; mode: Mode }) {
	const [text, setText] = useState('');
	const sendMessage = () => {
		if (text.trim()) {
			send({ type: 'tellClaude', text: text.trim() });
			setText('');
		}
	};

	const paused = watch.phase === 'paused';
	const working = watch.phase === 'working';

	return (
		<section className={`live phase-${watch.phase}`}>
			<div className="banner">
				<div className="banner-title">
					<span className="banner-icon">{PHASE_ICON[watch.phase]}</span>
					{watch.title}
				</div>
				{watch.detail && <div className="banner-detail">{watch.detail}</div>}
				{watch.request && watch.phase !== 'idle' && (
					<div className="banner-request" title={watch.request}>Your request: “{truncate(watch.request, 100)}”</div>
				)}
			</div>

			<div className="live-body">
				<div className={`big-actions ${mode === 'watch' ? '' : 'single'}`}>
					{mode !== 'watch' ? null : paused ? (
						<button className="big primary" onClick={() => send({ type: 'resumeClaude' })}>▶ Resume</button>
					) : (
						<button className="big" disabled={!working} onClick={() => send({ type: 'pauseClaude' })} title="Freeze the screen and make Claude wait before its next step">
							⏸ Pause
						</button>
					)}
					<button className="big danger" disabled={!working && !paused && watch.phase !== 'waiting'} onClick={() => send({ type: 'stopClaude' })} title="End what Claude is doing">
						■ Stop
					</button>
				</div>

				{watch.notice && <div className="live-notice">{watch.notice}</div>}

				{mode === 'watch' && watch.behind > 0 && (
					<div className="live-playback">
						{watch.playbackPaused ? 'Playback paused' : 'Catching up'} · {watch.behind} more change{watch.behind > 1 ? 's' : ''} to show
					</div>
				)}

				<div className="tell">
					<textarea
						rows={2}
						placeholder="Tell Claude something… e.g. use Tailwind instead"
						value={text}
						onChange={e => setText(e.target.value)}
						onKeyDown={e => {
							if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
								sendMessage();
							}
						}}
					/>
					<div className="tell-row">
						<span className="hint">
							{watch.messagesQueued > 0
								? `Claude gets your message at its next step`
								: paused
									? 'Sending a message also resumes Claude'
									: 'Ctrl+Enter to send'}
						</span>
						<button disabled={!text.trim()} onClick={sendMessage}>Send to Claude</button>
					</div>
				</div>

				{mode === 'watch' && (
					<label className="follow" title="Play each change on screen as Claude makes it">
						<input type="checkbox" checked={watch.followLive} onChange={e => send({ type: 'setFollowLive', value: e.target.checked })} />
						Play each change on screen as it happens
					</label>
				)}
			</div>
		</section>
	);
}

function TourBanner({ tour }: { tour: Tour }) {
	return (
		<section className="tour">
			<span className="tour-dot" />
			<span>
				Replaying change <b>{tour.index + 1}</b> of {tour.total}
			</span>
			<button onClick={() => send({ type: 'stopTour' })}>■ Stop</button>
		</section>
	);
}

function Timeline({ sessions, tour, hasApiKey, voice }: { sessions: TimelineSession[]; tour?: Tour; hasApiKey: boolean; voice: boolean }) {
	const [open, setOpen] = useState<number | undefined>();
	// Clicking a change opens its code in the editor and shows its details.
	const openEntry = (id: number) => {
		send({ type: 'openChange', id });
		setOpen(id);
	};
	if (sessions.length === 0) {
		return (
			<section className="timeline">
				<p className="muted small">Every change Claude makes will be saved here so you can replay it later.</p>
			</section>
		);
	}
	return (
		<section className="timeline">
			<div className="timeline-head">
				<span className="muted small">Click a change to open it · ▶ to replay it</span>
				<button className="link small" onClick={() => send({ type: 'clearTimeline' })}>Clear</button>
			</div>
			{sessions.map(session => (
				<div key={session.id} className="session">
					<div className="session-head">
						<span className="session-title">
							Claude session · {session.day}, {session.started}
							<span className="muted"> · {session.entries.length} change{session.entries.length === 1 ? '' : 's'}</span>
						</span>
						<button className="small" onClick={() => send({ type: 'replaySession', sessionId: session.id })} title="Replay every change in this session, one after another">
							▶ Replay session
						</button>
					</div>
					<ol className="entries">
						{session.entries.map(entry => (
							<li key={entry.id} className={`entry ${tour?.currentId === entry.id ? 'playing' : ''}`}>
								<button className="play" onClick={() => send({ type: 'replayChange', id: entry.id })} title="Replay this change">▶</button>
								<div className="entry-body">
									<div
										className="entry-top clickable"
										role="button"
										tabIndex={0}
										onClick={() => openEntry(entry.id)}
										onKeyDown={e => e.key === 'Enter' && openEntry(entry.id)}
										title="Open this code in the editor, and show details"
									>
										<span className="entry-file" title={entry.file}>{entry.file}</span>
										<span className="entry-counts">
											<span className="minus">−{entry.removedCount}</span> <span className="plus">+{entry.addedCount}</span>
										</span>
									</div>
									{entry.summary && <div className="entry-summary clickable" onClick={() => openEntry(entry.id)}>{entry.summary}</div>}
									<div className="entry-meta clickable" onClick={() => openEntry(entry.id)}>
										{entry.time}
										{entry.mode === 'watch' && <span className="tag">watched</span>}
										{entry.reviewed ? (
											<span className="tag ok" title="You've looked at this change">✓ reviewed</span>
										) : (
											<span className="tag warn" title="You haven't looked at this change yet">not reviewed</span>
										)}
										<span className="expand">{open === entry.id ? '▾ details' : '▸ open code · details · ask'}</span>
									</div>
									{open === entry.id && <EntryDetails entry={entry} hasApiKey={hasApiKey} voice={voice} />}
								</div>
							</li>
						))}
					</ol>
				</div>
			))}
		</section>
	);
}

// Expanded timeline entry: the change itself, its explanation, and questions about it.
function EntryDetails({ entry, hasApiKey, voice }: { entry: TimelineEntry; hasApiKey: boolean; voice: boolean }) {
	const [question, setQuestion] = useState('');
	const ask = () => {
		if (question.trim()) {
			send({ type: 'askChange', id: entry.id, question: question.trim() });
			setQuestion('');
		}
	};

	return (
		<div className="entry-details">
			{entry.request && <div className="request">You asked: “{truncate(entry.request, 160)}”</div>}

			<pre className="mini-diff">
				{entry.removed.map((line, i) => (
					<div key={`r${i}`} className="line removed"><span className="sign">−</span>{line || ' '}</div>
				))}
				{entry.added.map((line, i) => (
					<div key={`a${i}`} className="line added"><span className="sign">+</span>{line || ' '}</div>
				))}
			</pre>

			{entry.explaining ? (
				<ExplanationView explanation={{ status: 'loading' }} hasApiKey={hasApiKey} />
			) : entry.explanation ? (
				<ExplanationView explanation={entry.explanation} hasApiKey={hasApiKey} />
			) : (
				<button className="small" disabled={!hasApiKey && isWeb} onClick={() => (hasApiKey ? send({ type: 'explainChange', id: entry.id }) : send({ type: 'setApiKey' }))}>
					{hasApiKey ? '💡 Explain this change' : isWeb ? '💡 Explain (needs ANTHROPIC_API_KEY)' : '💡 Add an API key to explain changes'}
				</button>
			)}

			<QuizView id={entry.id} quiz={entry.quiz} hasApiKey={hasApiKey} voice={voice} />

			{entry.qa.length > 0 && (
				<ul className="qa">
					{entry.qa.map((qa, i) => (
						<li key={i}>
							<div className="q">Q: {qa.question}</div>
							{qa.answer ? (
								<div className="a">{qa.answer}</div>
							) : qa.error ? (
								<div className="explain-error">{qa.error}</div>
							) : (
								<div className="muted">Thinking…</div>
							)}
						</li>
					))}
				</ul>
			)}

			<div className="ask">
				<input
					type="text"
					placeholder="Ask about this change… e.g. why a loop here?"
					value={question}
					onChange={e => setQuestion(e.target.value)}
					onKeyDown={e => e.key === 'Enter' && ask()}
				/>
				<button disabled={!question.trim()} onClick={ask}>Ask</button>
			</div>
		</div>
	);
}

function ActivityFeed({ activity }: { activity: Activity[] }) {
	if (activity.length === 0) {
		return null;
	}
	return (
		<details className="activity">
			<summary>Recent decisions</summary>
			<ul>
				{activity.map(a => (
					<li key={a.id} className={`act ${a.kind}`}>
						<span className="act-kind">{ACTIVITY_LABEL[a.kind]}</span>
						<span className="act-file" title={a.file}>{a.file}</span>
						<span className="act-time">{a.time}</span>
						{a.detail && <div className="act-detail">“{a.detail}”</div>}
					</li>
				))}
			</ul>
		</details>
	);
}

// A quick multiple-choice check. Answering correctly marks the change as reviewed.
function QuizView({ id, quiz, hasApiKey, voice }: { id: number; quiz?: QuizState; hasApiKey: boolean; voice: boolean }) {
	const question = quiz?.status === 'ready' ? quiz.question : undefined;
	useEffect(() => {
		if (voice && question) {
			speak(question);
		}
	}, [voice, question]);

	if (!quiz) {
		return (
			<button className="small quiz-start" disabled={!hasApiKey && isWeb} onClick={() => (hasApiKey ? send({ type: 'quizChange', id }) : send({ type: 'setApiKey' }))}>
				{hasApiKey || !isWeb ? '🧠 Quiz me on this change' : '🧠 Quiz (needs ANTHROPIC_API_KEY)'}
			</button>
		);
	}
	if (quiz.status === 'loading') {
		return <div className="quiz muted">Writing a question…</div>;
	}
	if (quiz.status === 'error') {
		return <div className="quiz explain-error">{quiz.error}</div>;
	}
	const answered = quiz.chosen !== undefined;
	return (
		<div className="quiz">
			<div className="quiz-q">🧠 {quiz.question}</div>
			<div className="quiz-options">
				{quiz.options.map((option, i) => {
					const result = !answered ? '' : i === quiz.answer ? 'right' : i === quiz.chosen ? 'wrong' : '';
					return (
						<button key={i} className={`quiz-option ${result}`} disabled={answered} onClick={() => send({ type: 'answerQuiz', id, choice: i })}>
							{option}
						</button>
					);
				})}
			</div>
			{answered && (
				<div className={`quiz-result ${quiz.chosen === quiz.answer ? 'right' : 'wrong'}`}>
					{quiz.chosen === quiz.answer ? '✓ Correct! Marked as reviewed. ' : '✗ Not quite. '}
					{quiz.why}
				</div>
			)}
		</div>
	);
}

function unreviewedPercent(spots: BlindSpotsState): number {
	return spots.aiLines === 0 ? 0 : Math.round(((spots.aiLines - spots.reviewedLines) / spots.aiLines) * 100);
}

// The Blind Spots map: AI-written code still in the project that the user never reviewed.
function BlindSpots({ spots }: { spots: BlindSpotsState }) {
	if (spots.aiLines === 0) {
		return (
			<section className="blindspots">
				<p className="muted small">
					Once Claude writes code, this shows how much of it you have actually reviewed, and which files you have never looked at.
				</p>
			</section>
		);
	}
	const percent = unreviewedPercent(spots);
	const unreviewed = spots.aiLines - spots.reviewedLines;
	return (
		<section className="blindspots">
			<div className={`bs-headline ${percent === 0 ? 'good' : percent >= 50 ? 'bad' : 'meh'}`}>
				<div className="bs-percent">{percent}%</div>
				<div>
					<b>{percent === 0 ? 'You have reviewed all AI-written code here.' : 'of the AI-written code in this project has never been reviewed'}</b>
					<div className="muted small">
						{unreviewed} of {spots.aiLines} lines Claude wrote are still unreviewed
					</div>
				</div>
			</div>
			<Meter share={1 - percent / 100} />
			<ul className="bs-files">
				{spots.files.map(f => {
					const share = f.reviewedLines / f.aiLines;
					const done = f.reviewedLines === f.aiLines;
					return (
						<li key={f.file} className="bs-file">
							<div className="bs-file-top">
								<span className={`bs-dot ${done ? 'good' : share >= 0.5 ? 'meh' : 'bad'}`} />
								<span className="entry-file" title={f.file}>{f.file}</span>
								<span className="muted small">
									{f.aiLines - f.reviewedLines}/{f.aiLines} unreviewed
								</span>
							</div>
							<Meter share={share} small />
							{!done && (
								<div className="bs-actions">
									<button className="small" onClick={() => send({ type: 'walkthroughFile', file: f.file })}>
										▶ Walk me through ({f.unreviewedChanges} change{f.unreviewedChanges === 1 ? '' : 's'})
									</button>
									<button className="small link" onClick={() => send({ type: 'markUnderstood', file: f.file })}>
										I understand this file
									</button>
								</div>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

// A progress bar drawn with an SVG so it needs no inline styles (the panel's security policy blocks them).
function Meter({ share, small }: { share: number; small?: boolean }) {
	const width = Math.max(0, Math.min(100, Math.round(share * 100)));
	return (
		<svg className={`meter ${small ? 'small-meter' : ''}`} viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label={`${width}% reviewed`}>
			<rect className="meter-track" x="0" y="0" width="100" height="4" rx="2" />
			<rect className="meter-fill" x="0" y="0" width={width} height="4" rx="2" />
		</svg>
	);
}

function folderName(fullPath: string): string {
	return fullPath.split(/[\\/]/).filter(Boolean).pop() ?? fullPath;
}
