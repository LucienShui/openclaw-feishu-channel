import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
//#region src/sequential-queue.ts
/**
* Per-key serial task queue for Feishu inbound message handling.
*
* Tasks enqueued under the same key run in FIFO order. Different keys run
* concurrently. This preserves the channel's same-chat ordering contract
* (see #64324) while letting cross-chat work proceed in parallel.
*
* `taskTimeoutMs` bounds how long the queue will block subsequent same-key
* tasks behind a single in-flight task. After the cap, the in-flight task
* is evicted from the blocking chain so newer messages for the same key
* can proceed. The original task is NOT aborted — it continues running in
* the background; it just stops starving the queue.
*
* Without this cap, a single hung dispatch (e.g. an agent call that never
* resolves) keeps later same-chat messages in `queued` state until the
* gateway is restarted. See #70133.
*/
const DEFAULT_TASK_TIMEOUT_MS = 300 * 1e3;
function createSequentialQueue(options = {}) {
	const queues = /* @__PURE__ */ new Map();
	const taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
	const onTaskTimeout = options.onTaskTimeout;
	return (key, task) => {
		const previous = queues.get(key) ?? Promise.resolve();
		const wrapped = () => boundedRun(key, task, taskTimeoutMs, onTaskTimeout);
		const next = previous.then(wrapped, wrapped);
		queues.set(key, next);
		const cleanup = () => {
			if (queues.get(key) === next) queues.delete(key);
		};
		next.then(cleanup, cleanup);
		return next;
	};
}
async function boundedRun(key, task, timeoutMs, onTaskTimeout) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return task();
	const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, DEFAULT_TASK_TIMEOUT_MS);
	let timeoutHandle;
	const timeoutPromise = new Promise((resolve) => {
		timeoutHandle = setTimeout(() => {
			try {
				onTaskTimeout?.(key, resolvedTimeoutMs);
			} catch {}
			resolve();
		}, resolvedTimeoutMs);
	});
	try {
		await Promise.race([task(), timeoutPromise]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}
//#endregion
export { createSequentialQueue };
