import { loadSessionStore, resolveSessionStoreEntry } from "../runtime-api.js";
import { resolveFeishuConfigReasoningDefault } from "./agent-config.js";
import "./bot-runtime-api.js";
//#region src/reasoning-preview.ts
function resolveFeishuReasoningPreviewEnabled(params) {
	const configDefault = resolveFeishuConfigReasoningDefault(params.cfg, params.agentId);
	if (!params.sessionKey) return configDefault === "stream";
	try {
		const level = resolveSessionStoreEntry({
			store: loadSessionStore(params.storePath, { skipCache: true }),
			sessionKey: params.sessionKey
		}).existing?.reasoningLevel;
		if (level === "on" || level === "stream" || level === "off") return level === "stream";
	} catch {
		return false;
	}
	return configDefault === "stream";
}
//#endregion
export { resolveFeishuReasoningPreviewEnabled };
