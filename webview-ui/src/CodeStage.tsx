import { useEffect, useRef, useState } from 'react';
import type { WebStage } from '../../src/panel/protocol';
import { erasingLength, frame, type Frame, typingLength } from '../../src/stage/editPlan';
import { send } from './vscode';

// Glassbox Web's code view: plays an edit the same way the VS Code editor does.
// 1. the old code in red, 2. erased like backspacing, 3. the new code typed in green,
// 4. settles on BEFORE (red) above AFTER (green).

const TICK_MS = 33;
const HIGHLIGHT_MS = 1500;
const ERASE_MAX_MS = 1500;
const GAP_MS = 300;
const TYPING_MAX_MS = 6000;
const SETTLE_MS = 700;

export function CodeStage({ stage }: { stage?: WebStage }) {
	const [current, setCurrent] = useState<Frame | undefined>(() => (stage ? frame(stage.plan, 0, 0) : undefined));
	const paused = useRef(false);
	paused.current = !!stage?.paused;
	const changeRef = useRef<HTMLDivElement>(null);

	// Start a new animation whenever the server shows a new edit.
	useEffect(() => {
		if (!stage) {
			return;
		}
		const { plan, speed, key } = stage;
		const final = frame(plan, 0, typingLength(plan));
		if (stage.finished) {
			setCurrent(final);
			return;
		}
		const eraseTotal = erasingLength(plan);
		const typeTotal = typingLength(plan);
		const ticks = (ms: number) => Math.max(1, Math.floor(ms / speed / TICK_MS));
		const erasePerTick = Math.max(1, Math.ceil(eraseTotal / ticks(ERASE_MAX_MS)), Math.round(speed));
		const typePerTick = Math.max(1, Math.ceil(typeTotal / ticks(TYPING_MAX_MS)), Math.round(speed));
		let hold = eraseTotal > 0 ? ticks(HIGHLIGHT_MS) : 0;
		let erased = 0;
		let gap = eraseTotal > 0 ? ticks(GAP_MS) : 0;
		let typed = 0;
		let settle = eraseTotal > 0 ? ticks(SETTLE_MS) : 0;

		setCurrent(frame(plan, 0, 0));
		const finish = () => {
			clearInterval(timer);
			setCurrent(final);
			send({ type: 'stageDone', key });
		};
		const timer = setInterval(() => {
			if (paused.current) {
				return;
			}
			if (hold > 0) {
				hold--;
			} else if (erased < eraseTotal) {
				erased = Math.min(eraseTotal, erased + erasePerTick);
				setCurrent(frame(plan, erased, typed));
			} else if (gap > 0) {
				gap--;
			} else if (typed < typeTotal) {
				typed = Math.min(typeTotal, typed + typePerTick);
				setCurrent(frame(plan, erased, typed));
				if (eraseTotal === 0 && typed >= typeTotal) {
					finish();
				}
			} else if (settle > 0) {
				settle--;
			} else {
				finish();
			}
		}, TICK_MS);
		return () => clearInterval(timer);
	}, [stage?.key, stage?.finished]);

	// Keep the change in view.
	useEffect(() => {
		changeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}, [stage?.key]);

	if (!stage || !current) {
		return (
			<div className="code-stage empty-stage">
				<div className="empty-stage-text">
					<div className="idle-icon">◇</div>
					Claude's changes will play here as they happen.
				</div>
			</div>
		);
	}

	const lines = current.text.split('\n');
	const [removedStart, removedEnd] = current.removed;
	const [addedStart, addedEnd] = current.added;
	const focusLine = Math.max(0, Math.min(removedStart, addedStart));

	return (
		<div className="code-stage">
			<div className="code-title">
				<span className="code-file">{stage.label}</span>
				{stage.paused && <span className="code-paused">⏸ paused</span>}
			</div>
			<pre className="code">
				{lines.map((line, i) => {
					const removed = i >= removedStart && i < removedEnd;
					const added = i >= addedStart && i < addedEnd;
					return (
						<div key={i} ref={i === focusLine ? changeRef : undefined} className={`code-line ${removed ? 'removed' : added ? 'added' : ''}`}>
							<span className="ln">{i + 1}</span>
							<span className="sign">{removed ? '−' : added ? '+' : ' '}</span>
							<span className="text">{line || ' '}</span>
							{removed && i === removedStart && <span className="code-label removed">← BEFORE: Claude removes this</span>}
							{added && i === addedStart && <span className="code-label added">← AFTER: Claude writes this instead</span>}
						</div>
					);
				})}
			</pre>
		</div>
	);
}
