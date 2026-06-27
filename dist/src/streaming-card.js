import { requestFeishuApi } from "./comment-shared.js";
import { getFeishuUserAgent } from "./client.js";
import { resolveFeishuCardTemplate } from "./send.js";
import { asDateTimestampMs, resolveDateTimestampMs, resolveExpiresAtMsFromDurationSeconds } from "openclaw/plugin-sdk/number-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
//#region src/streaming-card.ts
const STREAMING_UPDATE_THROTTLE_MS = 160;
const STREAMING_SIGNIFICANT_DELTA_CHARS = 18;
const FEISHU_STREAMING_TOKEN_DEFAULT_LIFETIME_SECONDS = 7200;
const tokenCache = /* @__PURE__ */ new Map();
function resolveStreamingTokenExpiresAt(value, nowMs = Date.now()) {
	const now = resolveDateTimestampMs(nowMs);
	if (typeof value === "number" && Number.isFinite(value) && value <= 0) return now;
	return resolveExpiresAtMsFromDurationSeconds(value, { nowMs: now }) ?? resolveExpiresAtMsFromDurationSeconds(FEISHU_STREAMING_TOKEN_DEFAULT_LIFETIME_SECONDS, { nowMs: now }) ?? now;
}
function resolveApiBase(domain) {
	if (domain === "lark") return "https://open.larksuite.com/open-apis";
	if (domain && domain !== "feishu" && domain.startsWith("http")) return `${domain.replace(/\/+$/, "")}/open-apis`;
	return "https://open.feishu.cn/open-apis";
}
function resolveAllowedHostnames(domain) {
	if (domain === "lark") return ["open.larksuite.com"];
	if (domain && domain !== "feishu" && domain.startsWith("http")) try {
		return [new URL(domain).hostname];
	} catch {
		return [];
	}
	return ["open.feishu.cn"];
}
async function getToken(creds) {
	const key = `${creds.domain ?? "feishu"}|${creds.appId}`;
	const cached = tokenCache.get(key);
	const rawNow = Date.now();
	const hasValidClock = asDateTimestampMs(rawNow) !== void 0;
	const now = resolveDateTimestampMs(rawNow);
	const minUsableExpiresAt = resolveExpiresAtMsFromDurationSeconds(60, { nowMs: now }) ?? now;
	if (cached && hasValidClock && cached.expiresAt > minUsableExpiresAt) return cached.token;
	const { response, release } = await fetchWithSsrFGuard({
		url: `${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`,
		init: {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"User-Agent": getFeishuUserAgent()
			},
			body: JSON.stringify({
				app_id: creds.appId,
				app_secret: creds.appSecret
			})
		},
		policy: { allowedHostnames: resolveAllowedHostnames(creds.domain) },
		auditContext: "feishu.streaming-card.token"
	});
	if (!response.ok) {
		await release();
		throw new Error(`Token request failed with HTTP ${response.status}`);
	}
	const data = await response.json();
	await release();
	if (data.code !== 0 || !data.tenant_access_token) throw new Error(`Token error: ${data.msg}`);
	tokenCache.set(key, {
		token: data.tenant_access_token,
		expiresAt: resolveStreamingTokenExpiresAt(data.expire, now)
	});
	return data.tenant_access_token;
}
function truncateSummary(text, max = 50) {
	if (!text) return "";
	const clean = text.replace(/\n/g, " ").trim();
	return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}
function hasNaturalStreamingBoundary(text) {
	return /[\n。！？!?；;：:]$/.test(text);
}
function shouldPushStreamingUpdate(previousText, nextText) {
	if (!previousText) return true;
	if (hasNaturalStreamingBoundary(nextText)) return true;
	return nextText.length - previousText.length >= STREAMING_SIGNIFICANT_DELTA_CHARS;
}
function mergeStreamingText(previousText, nextText) {
	const previous = typeof previousText === "string" ? previousText : "";
	const next = typeof nextText === "string" ? nextText : "";
	if (!next) return previous;
	if (!previous || next === previous) return next;
	if (next.startsWith(previous)) return next;
	if (previous.startsWith(next)) return previous;
	if (next.includes(previous)) return next;
	if (previous.includes(next)) return previous;
	const maxOverlap = Math.min(previous.length, next.length);
	for (let overlap = maxOverlap; overlap > 0; overlap -= 1) if (previous.slice(-overlap) === next.slice(0, overlap)) return `${previous}${next.slice(overlap)}`;
	return `${previous}${next}`;
}
function resolveStreamingCardSendMode(options) {
	if (options?.replyToMessageId) return "reply";
	if (options?.rootId) return "root_create";
	return "create";
}
/** Streaming card session manager */
var FeishuStreamingSession = class {
	client;
	creds;
	state = null;
	queue = Promise.resolve();
	closed = false;
	log;
	lastUpdateTime = 0;
	pendingText = null;
	flushTimer = null;
	updateThrottleMs = STREAMING_UPDATE_THROTTLE_MS;
	constructor(client, creds, log) {
		this.client = client;
		this.creds = creds;
		this.log = log;
	}
	async start(receiveId, receiveIdType = "chat_id", options) {
		if (this.state) return;
		const apiBase = resolveApiBase(this.creds.domain);
		const elements = [{
			tag: "markdown",
			content: "",
			element_id: "content"
		}];
		if (options?.note) {
			elements.push({ tag: "hr" });
			elements.push({
				tag: "markdown",
				content: `<font color='grey'>${options.note}</font>`,
				element_id: "note"
			});
		}
		const cardJson = {
			schema: "2.0",
			config: {
				streaming_mode: true,
				summary: { content: "[Generating...]" },
				streaming_config: {
					print_frequency_ms: { default: 50 },
					print_step: { default: 1 }
				}
			},
			body: { elements }
		};
		if (options?.header) cardJson.header = {
			title: {
				tag: "plain_text",
				content: options.header.title
			},
			template: resolveFeishuCardTemplate(options.header.template) ?? "blue"
		};
		const { response: createRes, release: releaseCreate } = await fetchWithSsrFGuard({
			url: `${apiBase}/cardkit/v1/cards`,
			init: {
				method: "POST",
				headers: {
					Authorization: `Bearer ${await getToken(this.creds)}`,
					"Content-Type": "application/json",
					"User-Agent": getFeishuUserAgent()
				},
				body: JSON.stringify({
					type: "card_json",
					data: JSON.stringify(cardJson)
				})
			},
			policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
			auditContext: "feishu.streaming-card.create"
		});
		if (!createRes.ok) {
			await releaseCreate();
			throw new Error(`Create card request failed with HTTP ${createRes.status}`);
		}
		const createData = await createRes.json();
		await releaseCreate();
		if (createData.code !== 0 || !createData.data?.card_id) throw new Error(`Create card failed: ${createData.msg}`);
		const cardId = createData.data.card_id;
		const cardContent = JSON.stringify({
			type: "card",
			data: { card_id: cardId }
		});
		let sendRes;
		const sendOptions = options ?? {};
		const sendMode = resolveStreamingCardSendMode(sendOptions);
		if (sendMode === "reply") sendRes = await requestFeishuApi(() => this.client.im.message.reply({
			path: { message_id: sendOptions.replyToMessageId },
			data: {
				msg_type: "interactive",
				content: cardContent,
				...sendOptions.replyInThread ? { reply_in_thread: true } : {}
			}
		}), "Send card failed");
		else if (sendMode === "root_create") sendRes = await requestFeishuApi(() => this.client.im.message.create({
			params: { receive_id_type: receiveIdType },
			data: Object.assign({
				receive_id: receiveId,
				msg_type: "interactive",
				content: cardContent
			}, { root_id: sendOptions.rootId })
		}), "Send card failed");
		else sendRes = await requestFeishuApi(() => this.client.im.message.create({
			params: { receive_id_type: receiveIdType },
			data: {
				receive_id: receiveId,
				msg_type: "interactive",
				content: cardContent
			}
		}), "Send card failed");
		if (sendRes.code !== 0 || !sendRes.data?.message_id) throw new Error(`Send card failed: ${sendRes.msg}`);
		this.state = {
			cardId,
			messageId: sendRes.data.message_id,
			sequence: 1,
			currentText: "",
			sentText: "",
			hasNote: Boolean(options?.note)
		};
		this.log?.(`Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}`);
	}
	async updateCardContent(text, onError) {
		if (!this.state) return false;
		const apiBase = resolveApiBase(this.creds.domain);
		this.state.sequence += 1;
		try {
			const { response, release } = await fetchWithSsrFGuard({
				url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
				init: {
					method: "PUT",
					headers: {
						Authorization: `Bearer ${await getToken(this.creds)}`,
						"Content-Type": "application/json",
						"User-Agent": getFeishuUserAgent()
					},
					body: JSON.stringify({
						content: text,
						sequence: this.state.sequence,
						uuid: `s_${this.state.cardId}_${this.state.sequence}`
					})
				},
				policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
				auditContext: "feishu.streaming-card.update"
			});
			await release();
			if (!response.ok) {
				onError?.(/* @__PURE__ */ new Error(`Update card content failed with HTTP ${response.status}`));
				return false;
			}
			return true;
		} catch (error) {
			onError?.(error);
			return false;
		}
	}
	async replaceCardContent(text, onError) {
		if (!this.state) return false;
		const apiBase = resolveApiBase(this.creds.domain);
		this.state.sequence += 1;
		try {
			const { response, release } = await fetchWithSsrFGuard({
				url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/content`,
				init: {
					method: "PUT",
					headers: {
						Authorization: `Bearer ${await getToken(this.creds)}`,
						"Content-Type": "application/json",
						"User-Agent": getFeishuUserAgent()
					},
					body: JSON.stringify({
						element: JSON.stringify({
							tag: "markdown",
							content: text,
							element_id: "content"
						}),
						sequence: this.state.sequence,
						uuid: `r_${this.state.cardId}_${this.state.sequence}`
					})
				},
				policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
				auditContext: "feishu.streaming-card.replace"
			});
			await release();
			if (!response.ok) {
				onError?.(/* @__PURE__ */ new Error(`Replace card content failed with HTTP ${response.status}`));
				return false;
			}
			return true;
		} catch (error) {
			onError?.(error);
			return false;
		}
	}
	clearFlushTimer() {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}
	schedulePendingFlush() {
		if (this.flushTimer || !this.pendingText || this.closed) return;
		const delayMs = Math.max(0, this.updateThrottleMs - (Date.now() - this.lastUpdateTime));
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			const pending = this.pendingText;
			if (!pending || this.closed) return;
			this.update(pending);
		}, delayMs);
	}
	async update(text) {
		if (!this.state || this.closed) return;
		const mergedInput = mergeStreamingText(this.pendingText ?? this.state.currentText, text);
		if (!mergedInput || mergedInput === this.state.currentText) return;
		this.pendingText = mergedInput;
		this.clearFlushTimer();
		const shouldForceUpdate = shouldPushStreamingUpdate(this.state.currentText, mergedInput);
		const now = Date.now();
		if (!shouldForceUpdate && now - this.lastUpdateTime < this.updateThrottleMs) {
			this.schedulePendingFlush();
			return;
		}
		this.lastUpdateTime = now;
		this.queue = this.queue.then(async () => {
			if (!this.state || this.closed) return;
			const nextText = this.pendingText ?? mergedInput;
			const mergedText = mergeStreamingText(this.state.currentText, nextText);
			if (!mergedText || mergedText === this.state.currentText) return;
			if (mergedText === this.state.sentText) return;
			this.pendingText = null;
			this.state.currentText = mergedText;
			if (await this.updateCardContent(mergedText, (e) => this.log?.(`Update failed: ${String(e)}`)) && this.state) this.state.sentText = mergedText;
		});
		await this.queue;
	}
	async updateNoteContent(note) {
		if (!this.state || !this.state.hasNote) return;
		const apiBase = resolveApiBase(this.creds.domain);
		this.state.sequence += 1;
		await fetchWithSsrFGuard({
			url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/note/content`,
			init: {
				method: "PUT",
				headers: {
					Authorization: `Bearer ${await getToken(this.creds)}`,
					"Content-Type": "application/json",
					"User-Agent": getFeishuUserAgent()
				},
				body: JSON.stringify({
					content: `<font color='grey'>${note}</font>`,
					sequence: this.state.sequence,
					uuid: `n_${this.state.cardId}_${this.state.sequence}`
				})
			},
			policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
			auditContext: "feishu.streaming-card.note-update"
		}).then(async ({ release }) => {
			await release();
		}).catch((e) => this.log?.(`Note update failed: ${String(e)}`));
	}
	async close(finalText, options) {
		if (!this.state || this.closed) return false;
		this.closed = true;
		this.clearFlushTimer();
		await this.queue;
		const pendingMerged = mergeStreamingText(this.state.currentText, this.pendingText ?? void 0);
		const text = finalText ?? pendingMerged;
		const apiBase = resolveApiBase(this.creds.domain);
		let visibleContentSent = Boolean(this.state.sentText.trim());
		if ((text || finalText !== void 0) && text !== this.state.sentText) {
			const sent = text.startsWith(this.state.sentText) ? await this.updateCardContent(text, (e) => this.log?.(`Final update failed: ${String(e)}`)) : await this.replaceCardContent(text, (e) => this.log?.(`Final replace failed: ${String(e)}`));
			this.state.currentText = text;
			if (sent) {
				this.state.sentText = text;
				visibleContentSent = Boolean(text.trim());
			}
		}
		if (options?.note) await this.updateNoteContent(options.note);
		this.state.sequence += 1;
		await fetchWithSsrFGuard({
			url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/settings`,
			init: {
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${await getToken(this.creds)}`,
					"Content-Type": "application/json; charset=utf-8",
					"User-Agent": getFeishuUserAgent()
				},
				body: JSON.stringify({
					settings: JSON.stringify({ config: {
						streaming_mode: false,
						summary: { content: truncateSummary(text) }
					} }),
					sequence: this.state.sequence,
					uuid: `c_${this.state.cardId}_${this.state.sequence}`
				})
			},
			policy: { allowedHostnames: resolveAllowedHostnames(this.creds.domain) },
			auditContext: "feishu.streaming-card.close"
		}).then(async ({ release }) => {
			await release();
		}).catch((e) => this.log?.(`Close failed: ${String(e)}`));
		const finalState = this.state;
		this.state = null;
		this.pendingText = null;
		this.log?.(`Closed streaming: cardId=${finalState.cardId}`);
		return visibleContentSent;
	}
	async discard() {
		if (!this.state || this.closed) return;
		this.closed = true;
		this.clearFlushTimer();
		await this.queue;
		const currentState = this.state;
		try {
			const response = await this.client.im.message.delete({ path: { message_id: currentState.messageId } });
			if (response.code !== void 0 && response.code !== 0) throw new Error(`Delete streaming card message failed: ${response.msg ?? response.code}`);
			this.state = null;
			this.pendingText = null;
			this.log?.(`Discarded streaming card: cardId=${currentState.cardId}`);
		} catch (error) {
			this.log?.(`Discard failed: ${String(error)}`);
			this.closed = false;
			await this.close("");
		}
	}
	isActive() {
		return this.state !== null && !this.closed;
	}
};
//#endregion
export { FeishuStreamingSession, mergeStreamingText, resolveStreamingCardSendMode };
