import * as fs from 'fs';

// Reads Claude Code's transcript (one JSON object per line) to find what the user asked
// and what Claude said just before the edit, so explanations reflect Claude's real intent.

// Transcripts can grow large; the recent context is always near the end.
const TAIL_BYTES = 512 * 1024;
const MAX_REASONING_CHARS = 2000;

export interface EditContext {
	// The user's most recent request to Claude.
	request?: string;
	// What Claude wrote right before making the edit.
	reasoning?: string;
}

type Content = string | { type: string; text?: string }[] | undefined;

interface TranscriptLine {
	type?: string;
	isMeta?: boolean;
	message?: { role?: string; content?: Content };
}

export function readEditContext(transcriptPath: string | undefined): EditContext {
	if (!transcriptPath || !fs.existsSync(transcriptPath)) {
		return {};
	}
	const lines = readTail(transcriptPath).split('\n');

	const assistantTexts: string[] = [];
	let request: string | undefined;
	// Walk backwards: collect Claude's text until we reach the user's last real prompt.
	for (let i = lines.length - 1; i >= 0 && !request; i--) {
		const entry = parse(lines[i]);
		if (!entry?.message || entry.isMeta) {
			continue;
		}
		const text = textOf(entry.message.content);
		if (entry.type === 'assistant' && text) {
			assistantTexts.unshift(text);
		} else if (entry.type === 'user' && text) {
			// Tool results also arrive as "user" lines but carry no text blocks.
			request = text;
		}
	}

	const reasoning = assistantTexts.join('\n\n').trim();
	return {
		request: request?.trim(),
		reasoning: reasoning ? reasoning.slice(-MAX_REASONING_CHARS) : undefined,
	};
}

function readTail(file: string): string {
	const size = fs.statSync(file).size;
	const start = Math.max(0, size - TAIL_BYTES);
	const fd = fs.openSync(file, 'r');
	try {
		const buffer = Buffer.alloc(size - start);
		fs.readSync(fd, buffer, 0, buffer.length, start);
		const text = buffer.toString('utf8');
		// Drop the first (probably partial) line when we didn't start at the beginning.
		return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
	} finally {
		fs.closeSync(fd);
	}
}

function parse(line: string): TranscriptLine | undefined {
	if (!line.trim()) {
		return undefined;
	}
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

function textOf(content: Content): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	return content
		.filter(block => block.type === 'text' && block.text)
		.map(block => block.text)
		.join('\n');
}
