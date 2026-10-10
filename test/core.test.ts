// Tests for Glassbox's core logic (everything that doesn't need VS Code).
// Run with: npm run test:core
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as hooks from '../src/hooks';
import { toHookOutput } from '../src/server';
import { erasingLength, frame, planEdit, planFromTexts, typingLength } from '../src/stage/editPlan';
import { computeBlindSpots } from '../src/timeline/blindspots';
import { ChangeRecord, TimelineStore } from '../src/timeline/store';
import { WatchController } from '../src/watch';

const FILE = 'function greet(name) {\r\n  return "Hi " + name;\r\n}\r\n';
const edit = (old_string: string, new_string: string) => ({ tool_name: 'Edit', tool_input: { old_string, new_string } });

test('edit plan finds the change in a Windows (CRLF) file', () => {
	const plan = planEdit(edit('  return "Hi " + name;', '  // hi\n  return `Hello`;'), FILE);
	assert.equal(plan.matched, true);
	assert.deepEqual(plan.removed, ['  return "Hi " + name;']);
	assert.deepEqual(plan.added, ['  // hi', '  return `Hello`;']);
	assert.deepEqual(plan.before, ['function greet(name) {']);
});

test('animation: red, then erased, then typed, then BEFORE above AFTER', () => {
	const plan = planEdit(edit('  return "Hi " + name;', '  return `Hello`;'), FILE);
	assert.equal(frame(plan, 0, 0).text.split('\n')[1], '  return "Hi " + name;');
	assert.equal(frame(plan, erasingLength(plan), 0).text, 'function greet(name) {\n}\n');
	const end = frame(plan, erasingLength(plan), typingLength(plan));
	assert.equal(end.text.split('\n')[1], '  return `Hello`;');
	const review = frame(plan, 0, typingLength(plan));
	assert.deepEqual(review.text.split('\n').slice(1, 3), ['  return "Hi " + name;', '  return `Hello`;']);
	assert.deepEqual(review.removed, [1, 2]);
	assert.deepEqual(review.added, [2, 3]);
});

test('edit plan keeps "$" in new code literally', () => {
	const plan = planEdit(edit('"Hi "', '"$&"'), FILE);
	assert.equal(plan.added[0], '  return "$&" + name;');
});

test('a brand-new file is all added', () => {
	const plan = planEdit({ tool_name: 'Write', tool_input: { content: 'a\nb' } }, undefined);
	assert.deepEqual([plan.removed.length, plan.added.length], [0, 2]);
});

test('blind spots count AI lines still in the file, and which were reviewed', () => {
	const record = (id: number, added: string[], reviewed: boolean): ChangeRecord => ({
		id,
		time: new Date().toISOString(),
		sessionId: 's',
		file: 'a.js',
		tool: 'Edit',
		mode: 'watch',
		reviewed,
		plan: { before: [], after: [], removed: [], added, matched: true },
	});
	const records = [record(1, ['const a = 1;', '}'], true), record(2, ['const b = 2;', 'const gone = 3;'], false)];
	const spots = computeBlindSpots(records, () => 'const a = 1;\nconst b = 2;\n}\nconst mine = 4;');
	assert.equal(spots.aiLines, 2, 'braces and lines that no longer exist do not count');
	assert.equal(spots.reviewedLines, 1);
	assert.deepEqual(spots.files[0].unreviewedIds, [2]);
});

test('timeline store saves, reloads and marks changes reviewed', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-'));
	const store = new TimelineStore(dir);
	const saved = store.add({
		time: new Date().toISOString(),
		sessionId: 's',
		file: 'a.js',
		tool: 'Edit',
		mode: 'watch',
		plan: planFromTexts('a\n', 'b\n'),
	});
	store.markReviewed([saved.id]);
	await new Promise(resolve => setTimeout(resolve, 700));
	const reloaded = new TimelineStore(dir);
	assert.equal(reloaded.all.length, 1);
	assert.equal(reloaded.get(saved.id)?.reviewed, true);
});

test('pause holds the next step until resume', async () => {
	const watch = new WatchController();
	watch.promptSubmitted('build it');
	watch.pause();
	assert.equal(watch.view().phase, 'paused');
	let settled = false;
	const step = watch.gate({ tool_name: 'Read', tool_input: { file_path: '/p/a.js' } }, '/p').then(d => {
		settled = true;
		return d;
	});
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(settled, false, 'Claude is held while paused');
	assert.match(watch.view().detail ?? '', /next step will be: Reading/);
	watch.resume();
	assert.equal(await step, undefined, 'resuming lets the step run normally');
});

test('stop ends Claude at its next step and shows STOPPED right away', async () => {
	const watch = new WatchController();
	watch.promptSubmitted('build it');
	watch.stop();
	assert.equal(watch.view().phase, 'stopped');
	const decision = await watch.gate({ tool_name: 'Bash', tool_input: { command: 'ls' } }, '/p');
	assert.deepEqual(decision, { kind: 'stop', reason: 'Stopped from Glassbox.' });
	assert.deepEqual(toHookOutput(decision), { continue: false, stopReason: 'Stopped from Glassbox.' });
});

test('stop while idle does nothing (so it cannot kill the next request)', async () => {
	const watch = new WatchController();
	watch.stop();
	assert.notEqual(watch.view().phase, 'stopped');
	watch.promptSubmitted('next task');
	assert.equal(await watch.gate({ tool_name: 'Read' }, '/p'), undefined);
});

test('a message to Claude is delivered at its next step', async () => {
	const watch = new WatchController();
	watch.promptSubmitted('build it');
	watch.send('use tailwind');
	const decision = await watch.gate({ tool_name: 'Write', tool_input: { file_path: '/p/a.css' } }, '/p');
	assert.equal(decision?.kind, 'deny');
	assert.match(decision?.kind === 'deny' ? decision.reason : '', /use tailwind/);
});

test('connect writes hooks for every tool and keeps the user\'s own settings', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-'));
	fs.mkdirSync(path.join(dir, '.claude'));
	fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
	hooks.connect(dir, 7337);
	hooks.connect(dir, 7337);
	const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
	assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
	assert.equal(settings.hooks.PreToolUse.length, 1, 'connecting twice does not duplicate hooks');
	assert.equal(settings.hooks.PreToolUse[0].matcher, '*');
	assert.ok(settings.hooks.UserPromptSubmit && settings.hooks.Stop);
	hooks.disconnect(dir);
	const after = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
	assert.equal(after.hooks, undefined);
	assert.deepEqual(after.permissions, { allow: ['Bash(ls)'] });
});
