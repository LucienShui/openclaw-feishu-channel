import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
//#region src/async.ts
const RACE_TIMEOUT = Symbol("race-timeout");
const RACE_ABORT = Symbol("race-abort");
async function raceWithTimeoutAndAbort(promise, options = {}) {
	if (options.abortSignal?.aborted) return { status: "aborted" };
	if (options.timeoutMs === void 0 && !options.abortSignal) return {
		status: "resolved",
		value: await promise
	};
	let timeoutHandle;
	let abortHandler;
	const contenders = [promise];
	if (options.timeoutMs !== void 0) {
		const timeoutMs = resolveTimerTimeoutMs(options.timeoutMs, 1);
		contenders.push(new Promise((resolve) => {
			timeoutHandle = setTimeout(() => resolve(RACE_TIMEOUT), timeoutMs);
		}));
	}
	if (options.abortSignal) contenders.push(new Promise((resolve) => {
		abortHandler = () => resolve(RACE_ABORT);
		options.abortSignal?.addEventListener("abort", abortHandler, { once: true });
	}));
	try {
		const result = await Promise.race(contenders);
		if (result === RACE_TIMEOUT) return { status: "timeout" };
		if (result === RACE_ABORT) return { status: "aborted" };
		return {
			status: "resolved",
			value: result
		};
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (abortHandler) options.abortSignal?.removeEventListener("abort", abortHandler);
	}
}
function waitForAbortableDelay(delayMs, abortSignal) {
	if (abortSignal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (handleAbort) abortSignal?.removeEventListener("abort", handleAbort);
			resolve(value);
		};
		const handleAbort = () => {
			finish(false);
		};
		abortSignal?.addEventListener("abort", handleAbort, { once: true });
		if (abortSignal?.aborted) {
			finish(false);
			return;
		}
		const timer = setTimeout(() => finish(true), resolveTimerTimeoutMs(delayMs, 1));
		timer.unref?.();
	});
}
//#endregion
export { raceWithTimeoutAndAbort, waitForAbortableDelay };
