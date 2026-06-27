import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import { jsonToolResult, toolExecutionErrorResult, unknownToolActionResult } from "./tool-result.js";
import { FeishuWikiSchema } from "./wiki-schema.js";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
//#region src/wiki.ts
const WIKI_PAGE_SIZE = 50;
const WIKI_ACCESS_HINT = "To grant wiki access: Open wiki space → Settings → Members → Add the bot. See: https://open.feishu.cn/document/server-docs/docs/wiki-v2/wiki-qa#a40ad4ca";
function requireWikiSpaceId(value, fieldName) {
	if (typeof value !== "string") throw new Error(`${fieldName} must be a string. Feishu wiki space IDs are opaque identifiers; pass them quoted to avoid JavaScript number precision loss.`);
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${fieldName} must not be empty.`);
	return trimmed;
}
function optionalWikiSpaceId(value, fieldName) {
	if (value === void 0 || value === null || value === "") return;
	return requireWikiSpaceId(value, fieldName);
}
function readWikiPageSize(params) {
	return readPositiveIntegerParam(params, "page_size", {
		max: WIKI_PAGE_SIZE,
		message: "page_size must be a positive integer between 1 and 50"
	}) ?? WIKI_PAGE_SIZE;
}
async function listSpaces(client, pageSize, pageToken) {
	const res = await client.wiki.space.list({ params: {
		page_size: pageSize,
		page_token: pageToken
	} });
	if (res.code !== 0) throw new Error(res.msg);
	const spaces = res.data?.items?.map((s) => ({
		space_id: s.space_id,
		name: s.name,
		description: s.description,
		visibility: s.visibility
	})) ?? [];
	return {
		spaces,
		has_more: res.data?.has_more ?? false,
		page_token: res.data?.page_token,
		...spaces.length === 0 && pageToken === void 0 && res.data?.has_more !== true && { hint: WIKI_ACCESS_HINT }
	};
}
async function listNodes(client, spaceId, parentNodeToken, pageSize, pageToken) {
	const res = await client.wiki.spaceNode.list({
		path: { space_id: spaceId },
		params: {
			parent_node_token: parentNodeToken,
			page_size: pageSize,
			page_token: pageToken
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		nodes: res.data?.items?.map((n) => ({
			node_token: n.node_token,
			obj_token: n.obj_token,
			obj_type: n.obj_type,
			title: n.title,
			has_child: n.has_child
		})) ?? [],
		has_more: res.data?.has_more ?? false,
		page_token: res.data?.page_token
	};
}
async function getNode(client, token) {
	const res = await client.wiki.space.getNode({ params: { token } });
	if (res.code !== 0) throw new Error(res.msg);
	const node = res.data?.node;
	return {
		node_token: node?.node_token,
		space_id: node?.space_id,
		obj_token: node?.obj_token,
		obj_type: node?.obj_type,
		title: node?.title,
		parent_node_token: node?.parent_node_token,
		has_child: node?.has_child,
		creator: node?.creator,
		create_time: node?.node_create_time
	};
}
async function createNode(client, spaceId, title, objType, parentNodeToken) {
	const res = await client.wiki.spaceNode.create({
		path: { space_id: spaceId },
		data: {
			obj_type: objType || "docx",
			node_type: "origin",
			title,
			parent_node_token: parentNodeToken
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	const node = res.data?.node;
	return {
		node_token: node?.node_token,
		obj_token: node?.obj_token,
		obj_type: node?.obj_type,
		title: node?.title
	};
}
async function moveNode(client, spaceId, nodeToken, targetSpaceId, targetParentToken) {
	const res = await client.wiki.spaceNode.move({
		path: {
			space_id: spaceId,
			node_token: nodeToken
		},
		data: {
			target_space_id: targetSpaceId || spaceId,
			target_parent_token: targetParentToken
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		node_token: res.data?.node?.node_token
	};
}
async function renameNode(client, spaceId, nodeToken, title) {
	const res = await client.wiki.spaceNode.updateTitle({
		path: {
			space_id: spaceId,
			node_token: nodeToken
		},
		data: { title }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		node_token: nodeToken,
		title
	};
}
function registerFeishuWikiTools(api) {
	if (!api.config) return;
	const accounts = listEnabledFeishuAccounts(api.config);
	if (accounts.length === 0) return;
	if (!resolveAnyEnabledFeishuToolsConfig(accounts).wiki) return;
	api.registerTool((ctx) => {
		const defaultAccountId = ctx.agentAccountId;
		return {
			name: "feishu_wiki",
			label: "Feishu Wiki",
			description: "Feishu knowledge base operations. Actions: spaces, nodes, get, create, move, rename",
			parameters: FeishuWikiSchema,
			async execute(_toolCallId, params) {
				const p = params;
				try {
					const createClient = () => createFeishuToolClient({
						api,
						executeParams: p,
						defaultAccountId,
						requiredTool: {
							family: "wiki",
							label: "Wiki"
						}
					});
					switch (p.action) {
						case "spaces": return jsonToolResult(await listSpaces(createClient(), readWikiPageSize(p), p.page_token));
						case "nodes": {
							const spaceId = requireWikiSpaceId(p.space_id, "space_id");
							return jsonToolResult(await listNodes(createClient(), spaceId, p.parent_node_token, readWikiPageSize(p), p.page_token));
						}
						case "get": return jsonToolResult(await getNode(createClient(), p.token));
						case "search":
							optionalWikiSpaceId(p.space_id, "space_id");
							createClient();
							return jsonToolResult({ error: "Search is not available. Use feishu_wiki with action: 'nodes' to browse or action: 'get' to lookup by token." });
						case "create": {
							const spaceId = requireWikiSpaceId(p.space_id, "space_id");
							return jsonToolResult(await createNode(createClient(), spaceId, p.title, p.obj_type, p.parent_node_token));
						}
						case "move": {
							const spaceId = requireWikiSpaceId(p.space_id, "space_id");
							return jsonToolResult(await moveNode(createClient(), spaceId, p.node_token, optionalWikiSpaceId(p.target_space_id, "target_space_id"), p.target_parent_token));
						}
						case "rename": {
							const spaceId = requireWikiSpaceId(p.space_id, "space_id");
							return jsonToolResult(await renameNode(createClient(), spaceId, p.node_token, p.title));
						}
						default: return unknownToolActionResult(p.action);
					}
				} catch (err) {
					return toolExecutionErrorResult(err);
				}
			}
		};
	}, { name: "feishu_wiki" });
}
//#endregion
export { registerFeishuWikiTools };
