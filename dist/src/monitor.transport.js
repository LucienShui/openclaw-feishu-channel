import { createFeishuWSClient } from "./client.js";
import { waitForAbortableDelay } from "./async.js";
import { applyBasicWebhookRequestGuards, installRequestBodyLimitGuard, readWebhookBodyOrReject, resolveRequestClientIp, safeEqualSecret } from "./monitor-transport-runtime-api.js";
import { FEISHU_WEBHOOK_BODY_TIMEOUT_MS, FEISHU_WEBHOOK_MAX_BODY_BYTES, clearFeishuBotIdentityState, closeTrackedFeishuHttpServer, feishuWebhookRateLimiter, httpServers, recordWebhookStatus, wsClients } from "./monitor.state.js";
import * as Lark from "@larksuiteoapi/node-sdk";
import crypto from "node:crypto";
import * as http from "node:http";
//#region src/monitor.transport.ts
const FEISHU_WS_RECONNECT_INITIAL_DELAY_MS = 1e3;
const FEISHU_WS_RECONNECT_MAX_DELAY_MS = 3e4;
const FEISHU_WS_LOG_ERROR_MAX_LENGTH = 500;
const FEISHU_WS_RECONNECT_EXHAUSTED_RE = /^WebSocket reconnect exhausted after \d+ attempts?/;
const FEISHU_WS_AUTORECONNECT_DISABLED_ERROR = "WebSocket connect failed and autoReconnect is disabled";
function isFeishuWebhookPayload(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function buildFeishuWebhookEnvelope(req, payload) {
	return Object.assign(Object.create({ headers: req.headers }), payload);
}
function parseFeishuWebhookPayload(rawBody) {
	try {
		const parsed = JSON.parse(rawBody);
		return isFeishuWebhookPayload(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
function isFeishuWebhookSignatureValid(params) {
	const encryptKey = params.encryptKey?.trim();
	if (!encryptKey) return false;
	const timestampHeader = params.headers["x-lark-request-timestamp"];
	const nonceHeader = params.headers["x-lark-request-nonce"];
	const signatureHeader = params.headers["x-lark-signature"];
	const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
	const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
	const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
	if (!timestamp || !nonce || !signature) return false;
	return safeEqualSecret(crypto.createHash("sha256").update(timestamp + nonce + encryptKey + params.rawBody).digest("hex"), signature);
}
function respondText(res, statusCode, body) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "text/plain; charset=utf-8");
	res.end(body);
}
function normalizeFeishuWebhookRateLimitClient(clientIp) {
	if (!clientIp) return "unknown";
	if (clientIp === "::1" || clientIp.startsWith("127.")) return "loopback";
	return clientIp;
}
function buildFeishuWebhookRateLimitKey(params) {
	return `${params.accountId}:${params.path}:${normalizeFeishuWebhookRateLimitClient(params.clientIp)}`;
}
function getFeishuWsReconnectDelayMs(attempt) {
	return Math.min(FEISHU_WS_RECONNECT_INITIAL_DELAY_MS * 2 ** Math.max(0, attempt - 1), FEISHU_WS_RECONNECT_MAX_DELAY_MS);
}
function formatFeishuWsErrorForLog(err) {
	const raw = err instanceof Error ? err.message || err.name : String(err);
	const redacted = Array.from(raw, (char) => {
		const code = char.charCodeAt(0);
		return code <= 31 || code === 127 ? " " : char;
	}).join("").replace(/:\/\/[^:@/\s]+:[^@/\s]+@/g, "://[redacted]@").replace(/\b(authorization\s*[:=]\s*Bearer\s+)[^\s,;]+/gi, "$1[redacted]").replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, "$1[redacted]").replace(/\b((?:app[_-]?secret|tenant[_-]?access[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*)[^\s&;,]+/gi, "$1[redacted]").replace(/\s+/g, " ").trim();
	if (!redacted) return "unknown error";
	if (redacted.length <= FEISHU_WS_LOG_ERROR_MAX_LENGTH) return redacted;
	return `${redacted.slice(0, FEISHU_WS_LOG_ERROR_MAX_LENGTH)}...`;
}
function isFeishuWsTerminalError(err) {
	const message = err.message.trim();
	return FEISHU_WS_RECONNECT_EXHAUSTED_RE.test(message) || message.startsWith(FEISHU_WS_AUTORECONNECT_DISABLED_ERROR);
}
function cleanupFeishuWsClient(params) {
	const { accountId, wsClient, error, clearIdentity } = params;
	if (wsClient) try {
		wsClient.close();
	} catch (err) {
		error(`feishu[${accountId}]: error closing WebSocket client: ${formatFeishuWsErrorForLog(err)}`);
	}
	wsClients.delete(accountId);
	if (clearIdentity) clearFeishuBotIdentityState(accountId);
}
function waitForFeishuWsCycleEnd(params) {
	if (params.abortSignal?.aborted) return Promise.resolve("abort");
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			if (handleAbort) params.abortSignal?.removeEventListener("abort", handleAbort);
			resolve(result);
		};
		const handleAbort = () => finish("abort");
		params.abortSignal?.addEventListener("abort", handleAbort, { once: true });
		if (params.abortSignal?.aborted) {
			finish("abort");
			return;
		}
		params.terminalError.then(finish);
	});
}
function createFeishuWebSocketEventDispatcher(params) {
	const { accountId, eventDispatcher, error } = params;
	const asyncDispatcher = Object.create(eventDispatcher);
	asyncDispatcher.invoke = (data, invokeParams) => {
		setImmediate(() => {
			eventDispatcher.invoke(data, invokeParams).catch((err) => {
				error(`feishu[${accountId}]: error handling websocket event: ${String(err)}`);
			});
		});
		return Promise.resolve(void 0);
	};
	return asyncDispatcher;
}
async function monitorWebSocket({ account, accountId, runtime, abortSignal, eventDispatcher }) {
	const log = runtime?.log ?? console.log;
	const error = runtime?.error ?? console.error;
	let attempt = 0;
	while (true) {
		if (abortSignal?.aborted) break;
		let wsClient;
		try {
			let reportTerminalError = () => {};
			const terminalError = new Promise((resolve) => {
				reportTerminalError = resolve;
			});
			const handleWsError = (err) => {
				if (isFeishuWsTerminalError(err)) {
					reportTerminalError(err);
					return;
				}
				error(`feishu[${accountId}]: WebSocket SDK reported recoverable error: ${formatFeishuWsErrorForLog(err)}`);
			};
			log(`feishu[${accountId}]: starting WebSocket connection...`);
			wsClient = await createFeishuWSClient(account, { onError: handleWsError });
			if (abortSignal?.aborted) {
				cleanupFeishuWsClient({
					accountId,
					wsClient,
					error,
					clearIdentity: true
				});
				break;
			}
			wsClients.set(accountId, wsClient);
			await wsClient.start({ eventDispatcher: createFeishuWebSocketEventDispatcher({
				accountId,
				eventDispatcher,
				error
			}) });
			attempt = 0;
			log(`feishu[${accountId}]: WebSocket client started`);
			const cycleEnd = await waitForFeishuWsCycleEnd({
				abortSignal,
				terminalError
			});
			if (cycleEnd === "abort") {
				log(`feishu[${accountId}]: abort signal received, stopping`);
				cleanupFeishuWsClient({
					accountId,
					wsClient,
					error,
					clearIdentity: true
				});
				return;
			}
			cleanupFeishuWsClient({
				accountId,
				wsClient,
				error,
				clearIdentity: false
			});
			if (abortSignal?.aborted) break;
			attempt += 1;
			const delayMs = getFeishuWsReconnectDelayMs(attempt);
			error(`feishu[${accountId}]: WebSocket connection ended, recreating client in ${delayMs}ms: ${formatFeishuWsErrorForLog(cycleEnd)}`);
			if (!await waitForAbortableDelay(delayMs, abortSignal)) break;
		} catch (err) {
			cleanupFeishuWsClient({
				accountId,
				wsClient,
				error,
				clearIdentity: false
			});
			if (abortSignal?.aborted) break;
			attempt += 1;
			const delayMs = getFeishuWsReconnectDelayMs(attempt);
			error(`feishu[${accountId}]: WebSocket start failed, retrying in ${delayMs}ms: ${formatFeishuWsErrorForLog(err)}`);
			if (!await waitForAbortableDelay(delayMs, abortSignal)) break;
		}
	}
	cleanupFeishuWsClient({
		accountId,
		wsClient: void 0,
		error,
		clearIdentity: true
	});
}
async function monitorWebhook({ account, accountId, runtime, abortSignal, eventDispatcher }) {
	const log = runtime?.log ?? console.log;
	const error = runtime?.error ?? console.error;
	const encryptKey = account.encryptKey?.trim();
	if (!encryptKey) throw new Error(`Feishu account "${accountId}" webhook mode requires encryptKey`);
	const port = account.config.webhookPort ?? 3e3;
	const path = account.config.webhookPath ?? "/feishu/events";
	const host = account.config.webhookHost ?? "127.0.0.1";
	log(`feishu[${accountId}]: starting Webhook server on ${host}:${port}, path ${path}...`);
	const server = http.createServer();
	server.on("request", (req, res) => {
		res.on("finish", () => {
			recordWebhookStatus(runtime, accountId, path, res.statusCode);
		});
		if (!applyBasicWebhookRequestGuards({
			req,
			res,
			rateLimiter: feishuWebhookRateLimiter,
			rateLimitKey: buildFeishuWebhookRateLimitKey({
				accountId,
				path,
				clientIp: resolveRequestClientIp(req)
			}),
			nowMs: Date.now(),
			requireJsonContentType: true
		})) return;
		const guard = installRequestBodyLimitGuard(req, res, {
			maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
			timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
			responseFormat: "text"
		});
		if (guard.isTripped()) return;
		(async () => {
			try {
				const body = await readWebhookBodyOrReject({
					req,
					res,
					maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
					timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
					profile: "pre-auth"
				});
				if (!body.ok || res.writableEnded) return;
				if (guard.isTripped()) return;
				const rawBody = body.value;
				if (!isFeishuWebhookSignatureValid({
					headers: req.headers,
					rawBody,
					encryptKey
				})) {
					respondText(res, 401, "Invalid signature");
					return;
				}
				const payload = parseFeishuWebhookPayload(rawBody);
				if (!payload) {
					respondText(res, 400, "Invalid JSON");
					return;
				}
				const { isChallenge, challenge } = Lark.generateChallenge(payload, { encryptKey });
				if (isChallenge) {
					res.statusCode = 200;
					res.setHeader("Content-Type", "application/json; charset=utf-8");
					res.end(JSON.stringify(challenge));
					return;
				}
				const value = await eventDispatcher.invoke(buildFeishuWebhookEnvelope(req, payload), { needCheck: false });
				if (!res.headersSent) {
					res.statusCode = 200;
					res.setHeader("Content-Type", "application/json; charset=utf-8");
					res.end(JSON.stringify(value));
				}
			} catch (err) {
				error(`feishu[${accountId}]: webhook handler error: ${String(err)}`);
				if (!res.headersSent) respondText(res, 500, "Internal Server Error");
			} finally {
				guard.dispose();
			}
		})();
	});
	httpServers.set(accountId, server);
	return await new Promise((resolve, reject) => {
		let cleanupStarted = false;
		const cleanup = async () => {
			if (cleanupStarted) return;
			cleanupStarted = true;
			await closeTrackedFeishuHttpServer(accountId, server);
		};
		const handleAbort = () => {
			log(`feishu[${accountId}]: abort signal received, stopping Webhook server`);
			cleanup().then(resolve, reject);
		};
		if (abortSignal?.aborted) {
			cleanup().then(resolve, reject);
			return;
		}
		abortSignal?.addEventListener("abort", handleAbort, { once: true });
		server.listen(port, host, () => {
			log(`feishu[${accountId}]: Webhook server listening on ${host}:${port}`);
		});
		server.on("error", (err) => {
			error(`feishu[${accountId}]: Webhook server error: ${err}`);
			abortSignal?.removeEventListener("abort", handleAbort);
			reject(err);
		});
	});
}
//#endregion
export { buildFeishuWebhookRateLimitKey as buildFeishuWebhookRateLimitKeyForTest, monitorWebSocket, monitorWebhook };
