import { ChangeRecord } from './store';

// Blind spots: AI-written code that is still in the project but the user never reviewed.
// Lines are matched by content, so they're still found after other edits move them around.

export interface FileSpot {
	file: string;
	// AI-written lines currently in the file, and how many of those were reviewed.
	aiLines: number;
	reviewedLines: number;
	// Changes to this file the user hasn't reviewed yet (oldest first).
	unreviewedIds: number[];
}

export interface BlindSpots {
	files: FileSpot[];
	aiLines: number;
	reviewedLines: number;
}

// Braces, brackets and blank lines say nothing about understanding, so they don't count.
const TRIVIAL = /^[\s{}()[\];,]*$/;

export function isMeaningful(line: string): boolean {
	return !TRIVIAL.test(line);
}

// `readFile` returns a file's current contents (relative path), or undefined if it's gone.
export function computeBlindSpots(records: readonly ChangeRecord[], readFile: (file: string) => string | undefined): BlindSpots {
	const byFile = new Map<string, ChangeRecord[]>();
	for (const record of records) {
		const list = byFile.get(record.file) ?? [];
		list.push(record);
		byFile.set(record.file, list);
	}

	const files: FileSpot[] = [];
	for (const [file, fileRecords] of byFile) {
		const content = readFile(file);
		if (content === undefined) {
			continue;
		}
		// Which change last wrote each line of code (later changes win).
		const author = new Map<string, ChangeRecord>();
		for (const record of fileRecords) {
			for (const line of record.plan.added) {
				const key = line.trim();
				if (isMeaningful(key)) {
					author.set(key, record);
				}
			}
		}

		let aiLines = 0;
		let reviewedLines = 0;
		const unreviewed = new Set<number>();
		for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
			const record = author.get(line.trim());
			if (!record) {
				continue;
			}
			aiLines++;
			if (record.reviewed) {
				reviewedLines++;
			} else {
				unreviewed.add(record.id);
			}
		}
		if (aiLines > 0) {
			files.push({ file, aiLines, reviewedLines, unreviewedIds: [...unreviewed].sort((a, b) => a - b) });
		}
	}

	// Most unreviewed code first.
	files.sort((a, b) => b.aiLines - b.reviewedLines - (a.aiLines - a.reviewedLines) || a.file.localeCompare(b.file));
	return {
		files,
		aiLines: files.reduce((n, f) => n + f.aiLines, 0),
		reviewedLines: files.reduce((n, f) => n + f.reviewedLines, 0),
	};
}
