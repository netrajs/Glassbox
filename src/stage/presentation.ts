import { EditPlan } from './editPlan';

// One edit shown on screen, whichever screen it is: the VS Code editor (Stage)
// or the browser (Glassbox Web). No `vscode` import, so both can share it.
export interface Presentation {
	plan: EditPlan;
	// The line where Approve / Redirect buttons go.
	buttonLine: number;
	// Plays the animation from the start; resolves when it finishes (or is finished early).
	// `speed` > 1 plays faster (used to catch up when watching Claude live).
	replay(speed?: number): Promise<void>;
	// Freezes / continues the animation exactly where it is.
	pause(): void;
	resume(): void;
	// Jumps straight to the final BEFORE / AFTER view.
	finish(): void;
	dispose(): void;
}

// Something that can put an edit on screen.
export interface PresentationHost {
	show(plan: EditPlan, name: string): Promise<Presentation>;
}
