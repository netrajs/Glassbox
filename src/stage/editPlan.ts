import { HookInput } from '../types';

// Pure text logic for the Stage (no `vscode` import, so it is easy to test).
// Claude sends code with "\n" line endings, so everything here works on "\n" text.

export interface EditPlan {
	// Unchanged lines before and after the change.
	before: string[];
	after: string[];
	// Lines Claude removes, and the lines it adds in their place.
	removed: string[];
	added: string[];
	// False when the old code couldn't be found, so we only show the new code.
	matched: boolean;
}

export interface Frame {
	text: string;
	// Line ranges (inclusive start, exclusive end) in `text`.
	removed: [number, number];
	added: [number, number];
}

export function normalizeEol(text: string): string {
	return text.replace(/\r\n/g, '\n');
}

// `original` is the current file contents, or undefined if the file doesn't exist yet.
export function planEdit(input: HookInput, original: string | undefined): EditPlan {
	const current = normalizeEol(original ?? '');
	const { final, matched } = applyEdit(input, current);
	if (!matched) {
		return { before: [], after: [], removed: [], added: splitLines(final), matched: false };
	}
	return { ...changedBlock(splitLines(current), splitLines(final)), matched: true };
}

// A plan from two full versions of a file (used to record changes that already happened).
export function planFromTexts(before: string, after: string): EditPlan {
	return { ...changedBlock(splitLines(normalizeEol(before)), splitLines(normalizeEol(after))), matched: true };
}

// The file as Claude's edit would leave it.
export function applyEdit(input: HookInput, current: string): { final: string; matched: boolean } {
	const t = input.tool_input ?? {};
	switch (input.tool_name) {
		case 'Write':
			return { final: normalizeEol(t.content ?? ''), matched: true };
		case 'MultiEdit': {
			let text = current;
			for (const e of t.edits ?? []) {
				const next = replace(text, normalizeEol(e.old_string), normalizeEol(e.new_string), e.replace_all ?? false);
				if (next === undefined) {
					return { final: (t.edits ?? []).map(x => x.new_string).join('\n'), matched: false };
				}
				text = next;
			}
			return { final: text, matched: true };
		}
		default: {
			const next = replace(current, normalizeEol(t.old_string ?? ''), normalizeEol(t.new_string ?? ''), t.replace_all ?? false);
			return next === undefined ? { final: normalizeEol(t.new_string ?? ''), matched: false } : { final: next, matched: true };
		}
	}
}

// What the preview looks like after `erased` characters of the old code have been deleted
// (from the end, like backspacing) and `typed` characters of the new code have appeared.
export function frame(plan: EditPlan, erased: number, typed: number): Frame {
	const removedText = plan.removed.join('\n');
	const keptRemoved = removedText.slice(0, Math.max(0, removedText.length - erased));
	const removedLines = erased <= 0 ? plan.removed : keptRemoved ? keptRemoved.split('\n') : [];

	const addedText = plan.added.join('\n');
	const shown = addedText.slice(0, Math.max(0, typed));
	const addedLines = shown ? shown.split('\n') : [];

	const lines = [...plan.before, ...removedLines, ...addedLines, ...plan.after];
	const removedStart = plan.before.length;
	const addedStart = removedStart + removedLines.length;
	return {
		text: lines.join('\n'),
		removed: [removedStart, addedStart],
		added: [addedStart, addedStart + addedLines.length],
	};
}

export function typingLength(plan: EditPlan): number {
	return plan.added.join('\n').length;
}

export function erasingLength(plan: EditPlan): number {
	return plan.removed.join('\n').length;
}

// Splits two versions of a file into: same lines at the top, the changed block, same lines at the bottom.
function changedBlock(oldLines: string[], newLines: string[]): Omit<EditPlan, 'matched'> {
	let top = 0;
	while (top < oldLines.length && top < newLines.length && oldLines[top] === newLines[top]) {
		top++;
	}
	let bottom = 0;
	while (
		bottom < oldLines.length - top &&
		bottom < newLines.length - top &&
		oldLines[oldLines.length - 1 - bottom] === newLines[newLines.length - 1 - bottom]
	) {
		bottom++;
	}
	return {
		before: oldLines.slice(0, top),
		removed: oldLines.slice(top, oldLines.length - bottom),
		added: newLines.slice(top, newLines.length - bottom),
		after: oldLines.slice(oldLines.length - bottom),
	};
}

function replace(text: string, oldText: string, newText: string, all: boolean): string | undefined {
	if (!oldText || !text.includes(oldText)) {
		return undefined;
	}
	// split/join and a replacer function keep "$" in the new code literal.
	return all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
}

function splitLines(text: string): string[] {
	return text === '' ? [] : text.split('\n');
}

// Finds where `needle` occurs (first occurrence only, unless `all`). Used to flash finished edits.
export function findAll(haystack: string, needle: string, all: boolean): number[] {
	const result: number[] = [];
	if (!needle) {
		return result;
	}
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		result.push(index);
		if (!all) {
			break;
		}
		index = haystack.indexOf(needle, index + needle.length);
	}
	return result;
}
