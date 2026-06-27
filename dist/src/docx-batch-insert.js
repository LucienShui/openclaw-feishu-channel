import { cleanBlocksForDescendant } from "./docx-table-ops.js";
import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
//#region src/docx-batch-insert.ts
const BATCH_SIZE = 1e3;
function normalizeChildIds(children) {
	if (Array.isArray(children)) return children;
	const child = readStringValue(children);
	return child ? [child] : void 0;
}
function toDescendantBlock(block) {
	const children = normalizeChildIds(block.children);
	return {
		...block,
		...children ? { children } : {}
	};
}
/**
* Collect all descendant blocks for a given first-level block ID.
* Recursively traverses the block tree to gather all children.
*/
function collectDescendants(blockMap, rootId) {
	const result = [];
	const visited = /* @__PURE__ */ new Set();
	function collect(blockId) {
		if (visited.has(blockId)) return;
		visited.add(blockId);
		const block = blockMap.get(blockId);
		if (!block) return;
		result.push(block);
		const children = block.children;
		if (Array.isArray(children)) for (const childId of children) collect(childId);
		else if (typeof children === "string") collect(children);
	}
	collect(rootId);
	return result;
}
/**
* Insert a single batch of blocks using Descendant API.
*
* @param parentBlockId - Parent block to insert into (defaults to docToken)
* @param index - Position within parent's children (-1 = end)
*/
async function insertBatch(client, docToken, blocks, firstLevelBlockIds, parentBlockId = docToken, index = -1) {
	const descendants = cleanBlocksForDescendant(blocks);
	if (descendants.length === 0) return [];
	const res = await client.docx.documentBlockDescendant.create({
		path: {
			document_id: docToken,
			block_id: parentBlockId
		},
		data: {
			children_id: firstLevelBlockIds,
			descendants: descendants.map(toDescendantBlock),
			index
		}
	});
	if (res.code !== 0) throw new Error(`${res.msg} (code: ${res.code})`);
	return res.data?.children ?? [];
}
/**
* Insert blocks in batches for large documents (>1000 blocks).
*
* Batches are split to ensure BOTH children_id AND descendants
* arrays stay under the 1000 block API limit.
*
* @param client - Feishu API client
* @param docToken - Document ID
* @param blocks - All blocks from Convert API
* @param firstLevelBlockIds - IDs of top-level blocks to insert
* @param logger - Optional logger for progress updates
* @param parentBlockId - Parent block to insert into (defaults to docToken = document root)
* @param startIndex - Starting position within parent (-1 = end). For multi-batch inserts,
*   each batch advances this by the number of first-level IDs inserted so far.
* @returns Inserted children blocks and any skipped block IDs
*/
async function insertBlocksInBatches(client, docToken, blocks, firstLevelBlockIds, logger, parentBlockId = docToken, startIndex = -1) {
	const allChildren = [];
	const batches = [];
	let currentBatch = {
		firstLevelIds: [],
		blocks: []
	};
	const usedBlockIds = /* @__PURE__ */ new Set();
	const blockMap = /* @__PURE__ */ new Map();
	for (const block of blocks) if (block.block_id) blockMap.set(block.block_id, block);
	for (const firstLevelId of firstLevelBlockIds) {
		const newBlocks = collectDescendants(blockMap, firstLevelId).filter((b) => b.block_id && !usedBlockIds.has(b.block_id));
		if (newBlocks.length > 1e3) throw new Error(`Block "${firstLevelId}" has ${newBlocks.length} descendants, which exceeds the Feishu API limit of ${BATCH_SIZE} blocks per request. Please split the content into smaller sections.`);
		if (currentBatch.blocks.length + newBlocks.length > 1e3 && currentBatch.blocks.length > 0) {
			batches.push(currentBatch);
			currentBatch = {
				firstLevelIds: [],
				blocks: []
			};
		}
		currentBatch.firstLevelIds.push(firstLevelId);
		for (const block of newBlocks) {
			currentBatch.blocks.push(block);
			if (block.block_id) usedBlockIds.add(block.block_id);
		}
	}
	if (currentBatch.blocks.length > 0) batches.push(currentBatch);
	let currentIndex = startIndex;
	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		logger?.info?.(`feishu_doc: Inserting batch ${i + 1}/${batches.length} (${batch.blocks.length} blocks)...`);
		const children = await insertBatch(client, docToken, batch.blocks, batch.firstLevelIds, parentBlockId, currentIndex);
		allChildren.push(...children);
		if (currentIndex !== -1) currentIndex += batch.firstLevelIds.length;
	}
	return {
		children: allChildren,
		skipped: []
	};
}
//#endregion
export { BATCH_SIZE, insertBlocksInBatches };
