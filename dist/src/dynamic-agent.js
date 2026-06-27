import { resolveFeishuAccount } from "./accounts.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAccountId, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { createHash } from "node:crypto";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-writes";
//#region src/dynamic-agent.ts
var DynamicAgentMutationSkipped = class extends Error {
	cfg;
	constructor(cfg) {
		super("dynamic agent mutation skipped");
		this.cfg = cfg;
	}
};
function hasDefaultDirectRoute(cfg, accountId, senderOpenId) {
	return resolveAgentRoute({
		cfg,
		channel: "feishu",
		accountId,
		peer: {
			kind: "direct",
			id: senderOpenId
		}
	}).matchedBy === "default";
}
function resolveDynamicAgentConfig(cfg, accountId) {
	return resolveFeishuAccount({
		cfg,
		accountId
	}).config.dynamicAgentCreation;
}
function isAtDynamicAgentLimit(cfg, dynamicCfg) {
	if (dynamicCfg.maxAgents === void 0) return false;
	return (cfg.agents?.list ?? []).filter((agent) => agent.id.startsWith("feishu-")).length >= dynamicCfg.maxAgents;
}
function resolveDynamicAgentId(accountId, senderOpenId) {
	if (accountId === "default") return `feishu-${senderOpenId}`;
	const identityDigest = createHash("sha256").update(accountId).update("\0").update(senderOpenId).digest("hex").slice(0, 32);
	return `feishu-${accountId.slice(0, 12)}-${identityDigest}`;
}
/**
* Refresh an existing DM binding or create its dynamic agent when current
* account policy permits config writes.
*/
async function maybeCreateDynamicAgent(params) {
	const { cfg, runtime, senderOpenId, canCreateForConfig, log } = params;
	const accountId = normalizeAccountId(params.accountId);
	if (!hasDefaultDirectRoute(cfg, accountId, senderOpenId)) return {
		created: false,
		updatedCfg: cfg
	};
	const currentCfg = runtime.config.current();
	if (!hasDefaultDirectRoute(currentCfg, accountId, senderOpenId)) return {
		created: false,
		updatedCfg: currentCfg
	};
	const currentDynamicCfg = resolveDynamicAgentConfig(currentCfg, accountId);
	if (!currentDynamicCfg?.enabled) return {
		created: false,
		updatedCfg: currentCfg
	};
	if (!resolveChannelConfigWrites({
		cfg: currentCfg,
		channelId: "feishu",
		accountId
	})) {
		log(`feishu: config writes disabled, not creating agent for ${senderOpenId}`);
		return {
			created: false,
			updatedCfg: currentCfg
		};
	}
	const agentId = resolveDynamicAgentId(accountId, senderOpenId);
	if (!(currentCfg.agents?.list ?? []).some((agent) => agent.id === agentId) && isAtDynamicAgentLimit(currentCfg, currentDynamicCfg)) {
		log(`feishu: maxAgents limit (${currentDynamicCfg.maxAgents}) reached, not creating agent for ${senderOpenId}`);
		return {
			created: false,
			updatedCfg: currentCfg
		};
	}
	if (!await canCreateForConfig(currentCfg)) return {
		created: false,
		updatedCfg: currentCfg
	};
	let skippedCfg;
	const committed = await runtime.config.mutateConfigFile({
		base: "runtime",
		afterWrite: { mode: "auto" },
		mutate: async (draft) => {
			if (!hasDefaultDirectRoute(draft, accountId, senderOpenId)) throw new DynamicAgentMutationSkipped(draft);
			const dynamicCfg = resolveDynamicAgentConfig(draft, accountId);
			if (!dynamicCfg?.enabled || !resolveChannelConfigWrites({
				cfg: draft,
				channelId: "feishu",
				accountId
			})) throw new DynamicAgentMutationSkipped(draft);
			const agentExists = (draft.agents?.list ?? []).some((agent) => agent.id === agentId);
			if (!agentExists && isAtDynamicAgentLimit(draft, dynamicCfg)) {
				log(`feishu: maxAgents limit (${dynamicCfg.maxAgents}) reached, not creating agent for ${senderOpenId}`);
				throw new DynamicAgentMutationSkipped(draft);
			}
			if (!await canCreateForConfig(draft)) throw new DynamicAgentMutationSkipped(draft);
			if (!agentExists) {
				const workspaceTemplate = dynamicCfg.workspaceTemplate ?? "~/.openclaw/workspace-{agentId}";
				const agentDirTemplate = dynamicCfg.agentDirTemplate ?? "~/.openclaw/agents/{agentId}/agent";
				const workspace = resolveUserPath(workspaceTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId));
				const agentDir = resolveUserPath(agentDirTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId));
				log(`feishu: creating dynamic agent "${agentId}" for user ${senderOpenId}`);
				log(`  workspace: ${workspace}`);
				log(`  agentDir: ${agentDir}`);
				await fs.promises.mkdir(workspace, { recursive: true });
				await fs.promises.mkdir(agentDir, { recursive: true });
				draft.agents = {
					...draft.agents,
					list: [...draft.agents?.list ?? [], {
						id: agentId,
						workspace,
						agentDir
					}]
				};
			} else log(`feishu: agent "${agentId}" exists, adding missing binding for ${senderOpenId}`);
			draft.bindings = [...draft.bindings ?? [], {
				agentId,
				match: {
					channel: "feishu",
					accountId,
					peer: {
						kind: "direct",
						id: senderOpenId
					}
				}
			}];
			return {
				created: true,
				agentId
			};
		}
	}).catch((error) => {
		if (error instanceof DynamicAgentMutationSkipped) {
			skippedCfg = error.cfg;
			return null;
		}
		throw error;
	});
	if (!committed) return {
		created: false,
		updatedCfg: skippedCfg ?? currentCfg
	};
	return {
		created: committed.result?.created ?? false,
		updatedCfg: runtime.config.current(),
		agentId: committed.result?.agentId
	};
}
/**
* Resolve a path that may start with ~ to the user's home directory.
*/
function resolveUserPath(p) {
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}
//#endregion
export { maybeCreateDynamicAgent };
