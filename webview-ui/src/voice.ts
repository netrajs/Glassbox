// Reads text aloud with the browser's built-in voices (no setup, no API key).

export function speak(text: string): void {
	if (typeof speechSynthesis === 'undefined' || !text.trim()) {
		return;
	}
	speechSynthesis.cancel();
	const utterance = new SpeechSynthesisUtterance(text);
	utterance.rate = 1.05;
	speechSynthesis.speak(utterance);
}

export function stopSpeaking(): void {
	if (typeof speechSynthesis !== 'undefined') {
		speechSynthesis.cancel();
	}
}
