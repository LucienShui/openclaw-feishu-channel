import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuDocSchema } from "./doc-schema.js";
import { cleanBlocksForDescendant, deleteTableColumns, deleteTableRows, insertTableColumn, insertTableRow, mergeTableCells } from "./docx-table-ops.js";
import { insertBlocksInBatches } from "./docx-batch-insert.js";
import { updateColorText } from "./docx-color-text.js";
import { getFeishuRuntime } from "./runtime.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig, resolveFeishuToolAccount } from "./tool-account.js";
import { normalizeOptionalString, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { Type } from "typebox";
//#region src/docx.ts
function json(data) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(data, null, 2)
		}],
		details: data
	};
}
function resolveDocToolLocalRoots(ctx) {
	if (ctx.fsPolicy?.workspaceOnly !== true) return;
	const workspaceDir = ctx.workspaceDir?.trim();
	if (!workspaceDir) return [];
	return [resolve(workspaceDir)];
}
/** Extract image URLs from markdown content */
function extractImageUrls(markdown) {
	const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
	const urls = [];
	let match;
	while ((match = regex.exec(markdown)) !== null) {
		const url = match[1].trim();
		if (url.startsWith("http://") || url.startsWith("https://")) urls.push(url);
	}
	return urls;
}
const BLOCK_TYPE_NAMES = {
	1: "Page",
	2: "Text",
	3: "Heading1",
	4: "Heading2",
	5: "Heading3",
	12: "Bullet",
	13: "Ordered",
	14: "Code",
	15: "Quote",
	17: "Todo",
	18: "Bitable",
	21: "Diagram",
	22: "Divider",
	23: "File",
	27: "Image",
	30: "Sheet",
	31: "Table",
	32: "TableCell"
};
const UNSUPPORTED_CREATE_TYPES = /* @__PURE__ */ new Set([31, 32]);
/** Clean blocks for insertion (remove unsupported types and read-only fields) */
function cleanBlocksForInsert(blocks) {
	const skipped = [];
	return {
		cleaned: blocks.filter((block) => {
			if (UNSUPPORTED_CREATE_TYPES.has(block.block_type)) {
				const typeName = BLOCK_TYPE_NAMES[block.block_type] || `type_${block.block_type}`;
				skipped.push(typeName);
				return false;
			}
			return true;
		}).map((block) => {
			if (block.block_type === 31 && block.table?.merge_info) {
				const { merge_info: _merge_info, ...tableRest } = block.table;
				return Object.assign({}, block, { table: tableRest });
			}
			return block;
		}),
		skipped
	};
}
/** Max blocks per documentBlockChildren.create request */
const MAX_CONVERT_RETRY_DEPTH = 8;
async function convertMarkdown(client, markdown) {
	const res = await client.docx.document.convert({ data: {
		content_type: "markdown",
		content: markdown
	} });
	if (res.code !== 0) throw new Error(res.msg);
	return {
		blocks: res.data?.blocks ?? [],
		firstLevelBlockIds: res.data?.first_level_block_ids ?? []
	};
}
function normalizeChildIds(children) {
	if (Array.isArray(children)) return children.filter((child) => typeof child === "string");
	if (typeof children === "string") return [children];
	return [];
}
function toCreateChildBlock(block) {
	return block;
}
function toDescendantBlock(block) {
	const children = normalizeChildIds(block.children);
	return {
		...block.block_id ? { block_id: block.block_id } : {},
		...children.length > 0 ? { children } : {},
		...block
	};
}
function normalizeInsertedChildBlocks(children) {
	if (!Array.isArray(children)) return [];
	return children.filter((child) => typeof child === "object" && child !== null);
}
function normalizeConvertedBlockTree(blocks, firstLevelIds) {
	if (blocks.length <= 1) return {
		orderedBlocks: blocks,
		rootIds: blocks.length === 1 && typeof blocks[0]?.block_id === "string" ? [blocks[0].block_id] : []
	};
	const byId = /* @__PURE__ */ new Map();
	const originalOrder = /* @__PURE__ */ new Map();
	for (const [index, block] of blocks.entries()) if (typeof block?.block_id === "string") {
		byId.set(block.block_id, block);
		originalOrder.set(block.block_id, index);
	}
	const childIds = /* @__PURE__ */ new Set();
	for (const block of blocks) for (const childId of normalizeChildIds(block?.children)) childIds.add(childId);
	const inferredTopLevelIds = blocks.filter((block) => {
		const blockId = block?.block_id;
		if (typeof blockId !== "string") return false;
		const parentId = typeof block?.parent_id === "string" ? block.parent_id : "";
		return !childIds.has(blockId) && (!parentId || !byId.has(parentId));
	}).toSorted((a, b) => (originalOrder.get(a.block_id ?? "__missing__") ?? 0) - (originalOrder.get(b.block_id ?? "__missing__") ?? 0)).map((block) => block.block_id).filter((blockId) => typeof blockId === "string");
	const uniqueRootIds = uniqueStrings((firstLevelIds && firstLevelIds.length > 0 ? firstLevelIds : inferredTopLevelIds).filter((id) => typeof id === "string" && byId.has(id)));
	const orderedBlocks = [];
	const visited = /* @__PURE__ */ new Set();
	const visit = (blockId) => {
		if (!byId.has(blockId) || visited.has(blockId)) return;
		visited.add(blockId);
		const block = byId.get(blockId);
		if (!block) return;
		orderedBlocks.push(block);
		for (const childId of normalizeChildIds(block?.children)) visit(childId);
	};
	for (const rootId of uniqueRootIds) visit(rootId);
	for (const block of blocks) if (typeof block?.block_id === "string") visit(block.block_id);
	else orderedBlocks.push(block);
	return {
		orderedBlocks,
		rootIds: uniqueRootIds
	};
}
async function insertBlocks(client, docToken, blocks, parentBlockId, index) {
	const { cleaned, skipped } = cleanBlocksForInsert(blocks);
	const blockId = parentBlockId ?? docToken;
	if (cleaned.length === 0) return {
		children: [],
		skipped
	};
	const allInserted = [];
	for (const [offset, block] of cleaned.entries()) {
		const res = await client.docx.documentBlockChildren.create({
			path: {
				document_id: docToken,
				block_id: blockId
			},
			data: {
				children: [toCreateChildBlock(block)],
				...index !== void 0 ? { index: index + offset } : {}
			}
		});
		if (res.code !== 0) throw new Error(res.msg);
		allInserted.push(...res.data?.children ?? []);
	}
	return {
		children: allInserted,
		skipped
	};
}
/** Split markdown into chunks at top-level headings (# or ##) to stay within API content limits */
function splitMarkdownByHeadings(markdown) {
	const lines = markdown.split("\n");
	const chunks = [];
	let current = [];
	let inFencedBlock = false;
	for (const line of lines) {
		if (/^(`{3,}|~{3,})/.test(line)) inFencedBlock = !inFencedBlock;
		if (!inFencedBlock && /^#{1,2}\s/.test(line) && current.length > 0) {
			chunks.push(current.join("\n"));
			current = [];
		}
		current.push(line);
	}
	if (current.length > 0) chunks.push(current.join("\n"));
	return chunks;
}
/** Split markdown by size, preferring to break outside fenced code blocks when possible */
function splitMarkdownBySize(markdown, maxChars) {
	if (markdown.length <= maxChars) return [markdown];
	const lines = markdown.split("\n");
	const chunks = [];
	let current = [];
	let currentLength = 0;
	let inFencedBlock = false;
	for (const line of lines) {
		if (/^(`{3,}|~{3,})/.test(line)) inFencedBlock = !inFencedBlock;
		const lineLength = line.length + 1;
		const wouldExceed = currentLength + lineLength > maxChars;
		if (current.length > 0 && wouldExceed && !inFencedBlock) {
			chunks.push(current.join("\n"));
			current = [];
			currentLength = 0;
		}
		current.push(line);
		currentLength += lineLength;
	}
	if (current.length > 0) chunks.push(current.join("\n"));
	if (chunks.length > 1) return chunks;
	const midpoint = Math.floor(lines.length / 2);
	if (midpoint <= 0 || midpoint >= lines.length) return [markdown];
	return [lines.slice(0, midpoint).join("\n"), lines.slice(midpoint).join("\n")];
}
async function convertMarkdownWithFallback(client, markdown, depth = 0) {
	try {
		return await convertMarkdown(client, markdown);
	} catch (error) {
		if (depth >= MAX_CONVERT_RETRY_DEPTH || markdown.length < 2) throw error;
		const chunks = splitMarkdownBySize(markdown, Math.max(256, Math.floor(markdown.length / 2)));
		if (chunks.length <= 1) throw error;
		const blocks = [];
		const firstLevelBlockIds = [];
		for (const chunk of chunks) {
			const converted = await convertMarkdownWithFallback(client, chunk, depth + 1);
			blocks.push(...converted.blocks);
			firstLevelBlockIds.push(...converted.firstLevelBlockIds);
		}
		return {
			blocks,
			firstLevelBlockIds
		};
	}
}
/** Convert markdown in chunks to avoid document.convert content size limits */
async function chunkedConvertMarkdown(client, markdown) {
	const chunks = splitMarkdownByHeadings(markdown);
	const allBlocks = [];
	const allRootIds = [];
	for (const chunk of chunks) {
		const { blocks, firstLevelBlockIds } = await convertMarkdownWithFallback(client, chunk);
		const { orderedBlocks, rootIds } = normalizeConvertedBlockTree(blocks, firstLevelBlockIds);
		allBlocks.push(...orderedBlocks);
		allRootIds.push(...rootIds);
	}
	return {
		blocks: allBlocks,
		firstLevelBlockIds: allRootIds
	};
}
/**
* Insert blocks using the Descendant API (supports tables, nested lists, large docs).
* Unlike the Children API, this supports block_type 31/32 (Table/TableCell).
*
* @param parentBlockId - Parent block to insert into (defaults to docToken = document root)
* @param index - Position within parent's children (-1 = end, 0 = first)
*/
async function insertBlocksWithDescendant(client, docToken, blocks, firstLevelBlockIds, { parentBlockId = docToken, index = -1 } = {}) {
	const descendants = cleanBlocksForDescendant(blocks);
	if (descendants.length === 0) return { children: [] };
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
	return { children: res.data?.children ?? [] };
}
async function clearDocumentContent(client, docToken) {
	const existing = await client.docx.documentBlock.list({ path: { document_id: docToken } });
	if (existing.code !== 0) throw new Error(existing.msg);
	const childIds = existing.data?.items?.filter((b) => b.parent_id === docToken && b.block_type !== 1).map((b) => b.block_id) ?? [];
	if (childIds.length > 0) {
		const res = await client.docx.documentBlockChildren.batchDelete({
			path: {
				document_id: docToken,
				block_id: docToken
			},
			data: {
				start_index: 0,
				end_index: childIds.length
			}
		});
		if (res.code !== 0) throw new Error(res.msg);
	}
	return childIds.length;
}
async function uploadImageToDocx(client, blockId, imageBuffer, fileName, docToken) {
	const fileToken = (await client.drive.media.uploadAll({ data: {
		file_name: fileName,
		parent_type: "docx_image",
		parent_node: blockId,
		size: imageBuffer.length,
		file: imageBuffer,
		...docToken ? { extra: JSON.stringify({ drive_route_token: docToken }) } : {}
	} }))?.file_token;
	if (!fileToken) throw new Error("Image upload failed: no file_token returned");
	return fileToken;
}
async function downloadImage(url, maxBytes) {
	return (await getFeishuRuntime().channel.media.readRemoteMediaBuffer({
		url,
		maxBytes
	})).buffer;
}
async function resolveUploadInput(url, filePath, maxBytes, localRoots, explicitFileName, imageInput) {
	const inputSources = [
		url ? "url" : null,
		filePath ? "file_path" : null,
		imageInput ? "image" : null
	].filter(Boolean);
	if (inputSources.length > 1) throw new Error(`Provide only one image source; got: ${inputSources.join(", ")}`);
	if (imageInput?.startsWith("data:")) {
		const commaIdx = imageInput.indexOf(",");
		if (commaIdx === -1) throw new Error("Invalid data URI: missing comma separator.");
		const header = imageInput.slice(0, commaIdx);
		const data = imageInput.slice(commaIdx + 1);
		if (!header.includes(";base64")) throw new Error("Invalid data URI: missing ';base64' marker. Expected format: data:image/png;base64,<base64data>");
		const trimmedData = data.trim();
		if (trimmedData.length === 0 || !/^[A-Za-z0-9+/]+=*$/.test(trimmedData)) throw new Error(`Invalid data URI: base64 payload contains characters outside the standard alphabet.`);
		const ext = extensionForMime(header.match(/data:([^;]+)/)?.[1])?.slice(1) ?? "png";
		const estimatedBytes = Math.ceil(trimmedData.length * 3 / 4);
		if (estimatedBytes > maxBytes) throw new Error(`Image data URI exceeds limit: estimated ${estimatedBytes} bytes > ${maxBytes} bytes`);
		return {
			buffer: Buffer.from(trimmedData, "base64"),
			fileName: explicitFileName ?? `image.${ext}`
		};
	}
	if (imageInput) {
		const candidate = imageInput.startsWith("~") ? imageInput.replace(/^~/, homedir()) : imageInput;
		const unambiguousPath = imageInput.startsWith("~") || imageInput.startsWith("./") || imageInput.startsWith("../");
		const absolutePath = isAbsolute(imageInput);
		if (unambiguousPath || absolutePath && existsSync(candidate)) {
			const resolvedPath = resolve(candidate);
			return {
				buffer: (await getFeishuRuntime().media.loadWebMedia(resolvedPath, {
					maxBytes,
					optimizeImages: false,
					localRoots
				})).buffer,
				fileName: explicitFileName ?? basename(candidate)
			};
		}
		if (absolutePath && !existsSync(candidate)) throw new Error(`File not found: "${candidate}". If you intended to pass image binary data, use a data URI instead: data:image/jpeg;base64,...`);
	}
	if (imageInput) {
		const trimmed = imageInput.trim();
		if (trimmed.length === 0 || !/^[A-Za-z0-9+/]+=*$/.test(trimmed)) throw new Error("Invalid base64: image input contains characters outside the standard base64 alphabet. Use a data URI (data:image/png;base64,...) or a local file path instead.");
		const estimatedBytes = Math.ceil(trimmed.length * 3 / 4);
		if (estimatedBytes > maxBytes) throw new Error(`Base64 image exceeds limit: estimated ${estimatedBytes} bytes > ${maxBytes} bytes`);
		const buffer = Buffer.from(trimmed, "base64");
		if (buffer.length === 0) throw new Error("Base64 image decoded to empty buffer; check the input.");
		return {
			buffer,
			fileName: explicitFileName ?? "image.png"
		};
	}
	if (!url && !filePath) throw new Error("Either url, file_path, or image (base64/data URI) must be provided");
	if (url && filePath) throw new Error("Provide only one of url or file_path");
	if (url) {
		const fetched = await getFeishuRuntime().channel.media.readRemoteMediaBuffer({
			url,
			maxBytes
		});
		const guessed = new URL(url).pathname.split("/").pop() || "upload.bin";
		return {
			buffer: fetched.buffer,
			fileName: explicitFileName || guessed
		};
	}
	const resolvedFilePath = resolve(filePath);
	return {
		buffer: (await getFeishuRuntime().media.loadWebMedia(resolvedFilePath, {
			maxBytes,
			optimizeImages: false,
			localRoots
		})).buffer,
		fileName: explicitFileName || basename(filePath)
	};
}
async function processImages(client, docToken, markdown, insertedBlocks, maxBytes) {
	const imageUrls = extractImageUrls(markdown);
	if (imageUrls.length === 0) return 0;
	const imageBlocks = insertedBlocks.filter((b) => b.block_type === 27);
	let processed = 0;
	for (let i = 0; i < Math.min(imageUrls.length, imageBlocks.length); i++) {
		const url = imageUrls[i];
		const blockId = imageBlocks[i]?.block_id;
		if (!blockId) continue;
		try {
			const fileToken = await uploadImageToDocx(client, blockId, await downloadImage(url, maxBytes), new URL(url).pathname.split("/").pop() || `image_${i}.png`, docToken);
			await client.docx.documentBlock.patch({
				path: {
					document_id: docToken,
					block_id: blockId
				},
				data: { replace_image: { token: fileToken } }
			});
			processed++;
		} catch (err) {
			console.error(`Failed to process image ${url}:`, err);
		}
	}
	return processed;
}
async function uploadImageBlock(client, docToken, maxBytes, localRoots, url, filePath, parentBlockId, filename, index, imageInput) {
	const insertRes = await client.docx.documentBlockChildren.create({
		path: {
			document_id: docToken,
			block_id: parentBlockId ?? docToken
		},
		params: { document_revision_id: -1 },
		data: {
			children: [{
				block_type: 27,
				image: {}
			}],
			index: index ?? -1
		}
	});
	if (insertRes.code !== 0) throw new Error(`Failed to create image block: ${insertRes.msg}`);
	const imageBlockId = insertRes.data?.children?.find((b) => b.block_type === 27)?.block_id;
	if (!imageBlockId) throw new Error("Failed to create image block");
	const upload = await resolveUploadInput(url, filePath, maxBytes, localRoots, filename, imageInput);
	const fileToken = await uploadImageToDocx(client, imageBlockId, upload.buffer, upload.fileName, docToken);
	const patchRes = await client.docx.documentBlock.patch({
		path: {
			document_id: docToken,
			block_id: imageBlockId
		},
		data: { replace_image: { token: fileToken } }
	});
	if (patchRes.code !== 0) throw new Error(patchRes.msg);
	return {
		success: true,
		block_id: imageBlockId,
		file_token: fileToken,
		file_name: upload.fileName,
		size: upload.buffer.length
	};
}
async function uploadFileBlock(client, docToken, maxBytes, localRoots, url, filePath, parentBlockId, filename) {
	const blockId = parentBlockId ?? docToken;
	const upload = await resolveUploadInput(url, filePath, maxBytes, localRoots, filename);
	const converted = await convertMarkdown(client, `[${upload.fileName}](https://example.com/placeholder)`);
	const { orderedBlocks } = normalizeConvertedBlockTree(converted.blocks, converted.firstLevelBlockIds);
	const { children: inserted } = await insertBlocks(client, docToken, orderedBlocks, blockId);
	const placeholderBlock = inserted[0];
	if (!placeholderBlock?.block_id) throw new Error("Failed to create placeholder block for file upload");
	const parentId = placeholderBlock.parent_id ?? blockId;
	const childrenRes = await client.docx.documentBlockChildren.get({ path: {
		document_id: docToken,
		block_id: parentId
	} });
	if (childrenRes.code !== 0) throw new Error(childrenRes.msg);
	const placeholderIdx = (childrenRes.data?.items ?? []).findIndex((item) => item.block_id === placeholderBlock.block_id);
	if (placeholderIdx >= 0) {
		const deleteRes = await client.docx.documentBlockChildren.batchDelete({
			path: {
				document_id: docToken,
				block_id: parentId
			},
			data: {
				start_index: placeholderIdx,
				end_index: placeholderIdx + 1
			}
		});
		if (deleteRes.code !== 0) throw new Error(deleteRes.msg);
	}
	const fileToken = (await client.drive.media.uploadAll({ data: {
		file_name: upload.fileName,
		parent_type: "docx_file",
		parent_node: docToken,
		size: upload.buffer.length,
		file: upload.buffer
	} }))?.file_token;
	if (!fileToken) throw new Error("File upload failed: no file_token returned");
	return {
		success: true,
		file_token: fileToken,
		file_name: upload.fileName,
		size: upload.buffer.length,
		note: "File uploaded to drive. Use the file_token to reference it. Direct file block creation is not supported by the Feishu API."
	};
}
const STRUCTURED_BLOCK_TYPES = /* @__PURE__ */ new Set([
	14,
	18,
	21,
	23,
	27,
	30,
	31,
	32
]);
async function readDoc(client, docToken) {
	const [contentRes, infoRes, blocksRes] = await Promise.all([
		client.docx.document.rawContent({ path: { document_id: docToken } }),
		client.docx.document.get({ path: { document_id: docToken } }),
		client.docx.documentBlock.list({ path: { document_id: docToken } })
	]);
	if (contentRes.code !== 0) throw new Error(contentRes.msg);
	const blocks = blocksRes.data?.items ?? [];
	const blockCounts = {};
	const structuredTypes = [];
	for (const b of blocks) {
		const type = b.block_type ?? 0;
		const name = BLOCK_TYPE_NAMES[type] || `type_${type}`;
		blockCounts[name] = (blockCounts[name] || 0) + 1;
		if (STRUCTURED_BLOCK_TYPES.has(type) && !structuredTypes.includes(name)) structuredTypes.push(name);
	}
	let hint;
	if (structuredTypes.length > 0) hint = `This document contains ${structuredTypes.join(", ")} which are NOT included in the plain text above. Use feishu_doc with action: "list_blocks" to get full content.`;
	return {
		title: infoRes.data?.document?.title,
		content: contentRes.data?.content,
		revision_id: infoRes.data?.document?.revision_id,
		block_count: blocks.length,
		block_types: blockCounts,
		...hint && { hint }
	};
}
async function createDoc(client, title, folderToken, options) {
	const res = await client.docx.document.create({ data: {
		title,
		folder_token: folderToken
	} });
	if (res.code !== 0) throw new Error(res.msg);
	const doc = res.data?.document;
	const docToken = doc?.document_id;
	if (!docToken) throw new Error("Document creation succeeded but no document_id was returned");
	const shouldGrantToRequester = options?.grantToRequester !== false;
	const requesterOpenId = options?.requesterOpenId?.trim();
	const requesterPermType = "edit";
	let requesterPermissionAdded = false;
	let requesterPermissionSkippedReason;
	let requesterPermissionError;
	if (shouldGrantToRequester) if (!requesterOpenId) requesterPermissionSkippedReason = "trusted requester identity unavailable";
	else try {
		await client.drive.permissionMember.create({
			path: { token: docToken },
			params: {
				type: "docx",
				need_notification: false
			},
			data: {
				member_type: "openid",
				member_id: requesterOpenId,
				perm: requesterPermType
			}
		});
		requesterPermissionAdded = true;
	} catch (err) {
		requesterPermissionError = formatErrorMessage(err);
	}
	return {
		document_id: docToken,
		title: doc?.title,
		url: `https://feishu.cn/docx/${docToken}`,
		...shouldGrantToRequester && {
			requester_permission_added: requesterPermissionAdded,
			...requesterOpenId && { requester_open_id: requesterOpenId },
			requester_perm_type: requesterPermType,
			...requesterPermissionSkippedReason && { requester_permission_skipped_reason: requesterPermissionSkippedReason },
			...requesterPermissionError && { requester_permission_error: requesterPermissionError }
		}
	};
}
async function writeDoc(client, docToken, markdown, maxBytes, logger) {
	const deleted = await clearDocumentContent(client, docToken);
	logger?.info?.("feishu_doc: Converting markdown...");
	const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(client, markdown);
	if (blocks.length === 0) return {
		success: true,
		blocks_deleted: deleted,
		blocks_added: 0,
		images_processed: 0
	};
	logger?.info?.(`feishu_doc: Converted to ${blocks.length} blocks, inserting...`);
	const { orderedBlocks, rootIds } = normalizeConvertedBlockTree(blocks, firstLevelBlockIds);
	const { children: inserted } = blocks.length > 1e3 ? await insertBlocksInBatches(client, docToken, orderedBlocks, rootIds, logger) : await insertBlocksWithDescendant(client, docToken, orderedBlocks, rootIds);
	const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);
	logger?.info?.(`feishu_doc: Done (${blocks.length} blocks, ${imagesProcessed} images)`);
	return {
		success: true,
		blocks_deleted: deleted,
		blocks_added: blocks.length,
		images_processed: imagesProcessed
	};
}
async function appendDoc(client, docToken, markdown, maxBytes, logger) {
	logger?.info?.("feishu_doc: Converting markdown...");
	const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(client, markdown);
	if (blocks.length === 0) throw new Error("Content is empty");
	logger?.info?.(`feishu_doc: Converted to ${blocks.length} blocks, inserting...`);
	const { orderedBlocks, rootIds } = normalizeConvertedBlockTree(blocks, firstLevelBlockIds);
	const { children: inserted } = blocks.length > 1e3 ? await insertBlocksInBatches(client, docToken, orderedBlocks, rootIds, logger) : await insertBlocksWithDescendant(client, docToken, orderedBlocks, rootIds);
	const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);
	logger?.info?.(`feishu_doc: Done (${blocks.length} blocks, ${imagesProcessed} images)`);
	return {
		success: true,
		blocks_added: blocks.length,
		images_processed: imagesProcessed,
		block_ids: inserted.map((b) => b.block_id)
	};
}
async function insertDoc(client, docToken, markdown, afterBlockId, maxBytes, logger) {
	const blockInfo = await client.docx.documentBlock.get({ path: {
		document_id: docToken,
		block_id: afterBlockId
	} });
	if (blockInfo.code !== 0) throw new Error(blockInfo.msg);
	const parentId = blockInfo.data?.block?.parent_id ?? docToken;
	const items = [];
	let pageToken;
	do {
		const childrenRes = await client.docx.documentBlockChildren.get({
			path: {
				document_id: docToken,
				block_id: parentId
			},
			params: pageToken ? { page_token: pageToken } : {}
		});
		if (childrenRes.code !== 0) throw new Error(childrenRes.msg);
		items.push(...childrenRes.data?.items ?? []);
		pageToken = childrenRes.data?.page_token ?? void 0;
	} while (pageToken);
	const blockIndex = items.findIndex((item) => item.block_id === afterBlockId);
	if (blockIndex === -1) throw new Error(`after_block_id "${afterBlockId}" was not found among the children of parent block "${parentId}". Use list_blocks to verify the block ID.`);
	const insertIndex = blockIndex + 1;
	logger?.info?.("feishu_doc: Converting markdown...");
	const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(client, markdown);
	if (blocks.length === 0) throw new Error("Content is empty");
	const { orderedBlocks, rootIds } = normalizeConvertedBlockTree(blocks, firstLevelBlockIds);
	logger?.info?.(`feishu_doc: Converted to ${blocks.length} blocks, inserting at index ${insertIndex}...`);
	const { children: inserted } = blocks.length > 1e3 ? await insertBlocksInBatches(client, docToken, orderedBlocks, rootIds, logger, parentId, insertIndex) : await insertBlocksWithDescendant(client, docToken, orderedBlocks, rootIds, {
		parentBlockId: parentId,
		index: insertIndex
	});
	const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);
	logger?.info?.(`feishu_doc: Done (${blocks.length} blocks, ${imagesProcessed} images)`);
	return {
		success: true,
		blocks_added: blocks.length,
		images_processed: imagesProcessed,
		block_ids: inserted.map((b) => b.block_id)
	};
}
async function createTable(client, docToken, rowSize, columnSize, parentBlockId, columnWidth) {
	if (columnWidth && columnWidth.length !== columnSize) throw new Error("column_width length must equal column_size");
	const blockId = parentBlockId ?? docToken;
	const res = await client.docx.documentBlockChildren.create({
		path: {
			document_id: docToken,
			block_id: blockId
		},
		data: { children: [{
			block_type: 31,
			table: { property: {
				row_size: rowSize,
				column_size: columnSize,
				...columnWidth && columnWidth.length > 0 ? { column_width: columnWidth } : {}
			} }
		}] }
	});
	if (res.code !== 0) throw new Error(res.msg);
	const tableBlock = res.data?.children?.find((b) => b.block_type === 31);
	const cells = normalizeInsertedChildBlocks(tableBlock?.children);
	return {
		success: true,
		table_block_id: tableBlock?.block_id,
		row_size: rowSize,
		column_size: columnSize,
		table_cell_block_ids: cells.map((c) => c.block_id).filter(Boolean),
		raw_children_count: res.data?.children?.length ?? 0
	};
}
async function writeTableCells(client, docToken, tableBlockId, values) {
	if (!values.length || !values[0]?.length) throw new Error("values must be a non-empty 2D array");
	const tableRes = await client.docx.documentBlock.get({ path: {
		document_id: docToken,
		block_id: tableBlockId
	} });
	if (tableRes.code !== 0) throw new Error(tableRes.msg);
	const tableBlock = tableRes.data?.block;
	if (tableBlock?.block_type !== 31) throw new Error("table_block_id is not a table block");
	const tableData = tableBlock.table;
	const rows = tableData?.property?.row_size;
	const cols = tableData?.property?.column_size;
	const cellIds = tableData?.cells ?? [];
	if (!rows || !cols || !cellIds.length) throw new Error("Table cell IDs unavailable from table block. Use list_blocks/get_block and pass explicit cell block IDs if needed.");
	const writeRows = Math.min(values.length, rows);
	let written = 0;
	for (let r = 0; r < writeRows; r++) {
		const rowValues = values[r] ?? [];
		const writeCols = Math.min(rowValues.length, cols);
		for (let c = 0; c < writeCols; c++) {
			const cellId = cellIds[r * cols + c];
			if (!cellId) continue;
			const childrenRes = await client.docx.documentBlockChildren.get({ path: {
				document_id: docToken,
				block_id: cellId
			} });
			if (childrenRes.code !== 0) throw new Error(childrenRes.msg);
			const existingChildren = childrenRes.data?.items ?? [];
			if (existingChildren.length > 0) {
				const delRes = await client.docx.documentBlockChildren.batchDelete({
					path: {
						document_id: docToken,
						block_id: cellId
					},
					data: {
						start_index: 0,
						end_index: existingChildren.length
					}
				});
				if (delRes.code !== 0) throw new Error(delRes.msg);
			}
			const converted = await convertMarkdown(client, rowValues[c] ?? "");
			const { orderedBlocks } = normalizeConvertedBlockTree(converted.blocks, converted.firstLevelBlockIds);
			if (orderedBlocks.length > 0) await insertBlocks(client, docToken, orderedBlocks, cellId);
			written++;
		}
	}
	return {
		success: true,
		table_block_id: tableBlockId,
		cells_written: written,
		table_size: {
			rows,
			cols
		}
	};
}
async function createTableWithValues(client, docToken, rowSize, columnSize, values, parentBlockId, columnWidth) {
	const tableBlockId = (await createTable(client, docToken, rowSize, columnSize, parentBlockId, columnWidth)).table_block_id;
	if (!tableBlockId) throw new Error("create_table succeeded but table_block_id is missing");
	return {
		success: true,
		table_block_id: tableBlockId,
		row_size: rowSize,
		column_size: columnSize,
		cells_written: (await writeTableCells(client, docToken, tableBlockId, values)).cells_written
	};
}
async function updateBlock(client, docToken, blockId, content) {
	const blockInfo = await client.docx.documentBlock.get({ path: {
		document_id: docToken,
		block_id: blockId
	} });
	if (blockInfo.code !== 0) throw new Error(blockInfo.msg);
	const res = await client.docx.documentBlock.patch({
		path: {
			document_id: docToken,
			block_id: blockId
		},
		data: { update_text_elements: { elements: [{ text_run: { content } }] } }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		block_id: blockId
	};
}
async function deleteBlock(client, docToken, blockId) {
	const blockInfo = await client.docx.documentBlock.get({ path: {
		document_id: docToken,
		block_id: blockId
	} });
	if (blockInfo.code !== 0) throw new Error(blockInfo.msg);
	const parentId = blockInfo.data?.block?.parent_id ?? docToken;
	const children = await client.docx.documentBlockChildren.get({ path: {
		document_id: docToken,
		block_id: parentId
	} });
	if (children.code !== 0) throw new Error(children.msg);
	const index = (children.data?.items ?? []).findIndex((item) => item.block_id === blockId);
	if (index === -1) throw new Error("Block not found");
	const res = await client.docx.documentBlockChildren.batchDelete({
		path: {
			document_id: docToken,
			block_id: parentId
		},
		data: {
			start_index: index,
			end_index: index + 1
		}
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		deleted_block_id: blockId
	};
}
async function listBlocks(client, docToken) {
	const res = await client.docx.documentBlock.list({ path: { document_id: docToken } });
	if (res.code !== 0) throw new Error(res.msg);
	return { blocks: res.data?.items ?? [] };
}
async function getBlock(client, docToken, blockId) {
	const res = await client.docx.documentBlock.get({ path: {
		document_id: docToken,
		block_id: blockId
	} });
	if (res.code !== 0) throw new Error(res.msg);
	return { block: res.data?.block };
}
async function listAppScopes(client) {
	const res = await client.application.scope.list({});
	if (res.code !== 0) throw new Error(res.msg);
	const scopes = res.data?.scopes ?? [];
	const granted = scopes.filter((s) => s.grant_status === 1);
	const pending = scopes.filter((s) => s.grant_status !== 1);
	return {
		granted: granted.map((s) => ({
			name: s.scope_name,
			type: s.scope_type
		})),
		pending: pending.map((s) => ({
			name: s.scope_name,
			type: s.scope_type
		})),
		summary: `${granted.length} granted, ${pending.length} pending`
	};
}
function registerFeishuDocTools(api) {
	if (!api.config) return;
	const accounts = listEnabledFeishuAccounts(api.config);
	if (accounts.length === 0) return;
	const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
	const registered = [];
	const getClient = (params, defaultAccountId) => createFeishuToolClient({
		api,
		executeParams: params,
		defaultAccountId,
		requiredTool: {
			family: "doc",
			label: "Doc"
		}
	});
	const getMediaMaxBytes = (params, defaultAccountId) => (resolveFeishuToolAccount({
		api,
		executeParams: params,
		defaultAccountId,
		requiredTool: {
			family: "doc",
			label: "Doc"
		}
	}).config?.mediaMaxMb ?? 30) * 1024 * 1024;
	if (toolsCfg.doc) {
		api.registerTool((ctx) => {
			const defaultAccountId = ctx.agentAccountId;
			const mediaLocalRoots = resolveDocToolLocalRoots(ctx);
			const trustedRequesterOpenId = ctx.messageChannel === "feishu" ? normalizeOptionalString(ctx.requesterSenderId) : void 0;
			return {
				name: "feishu_doc",
				label: "Feishu Doc",
				description: "Feishu document operations. Actions: read, write, append, insert, create, list_blocks, get_block, update_block, delete_block, create_table, write_table_cells, create_table_with_values, insert_table_row, insert_table_column, delete_table_rows, delete_table_columns, merge_table_cells, upload_image, upload_file, color_text",
				parameters: FeishuDocSchema,
				async execute(_toolCallId, params) {
					const p = params;
					try {
						const client = getClient(p, defaultAccountId);
						switch (p.action) {
							case "read": return json(await readDoc(client, p.doc_token));
							case "write": return json(await writeDoc(client, p.doc_token, p.content, getMediaMaxBytes(p, defaultAccountId), api.logger));
							case "append": return json(await appendDoc(client, p.doc_token, p.content, getMediaMaxBytes(p, defaultAccountId), api.logger));
							case "insert": return json(await insertDoc(client, p.doc_token, p.content, p.after_block_id, getMediaMaxBytes(p, defaultAccountId), api.logger));
							case "create": return json(await createDoc(client, p.title, p.folder_token, {
								grantToRequester: p.grant_to_requester,
								requesterOpenId: trustedRequesterOpenId
							}));
							case "list_blocks": return json(await listBlocks(client, p.doc_token));
							case "get_block": return json(await getBlock(client, p.doc_token, p.block_id));
							case "update_block": return json(await updateBlock(client, p.doc_token, p.block_id, p.content));
							case "delete_block": return json(await deleteBlock(client, p.doc_token, p.block_id));
							case "create_table": return json(await createTable(client, p.doc_token, p.row_size, p.column_size, p.parent_block_id, p.column_width));
							case "write_table_cells": return json(await writeTableCells(client, p.doc_token, p.table_block_id, p.values));
							case "create_table_with_values": return json(await createTableWithValues(client, p.doc_token, p.row_size, p.column_size, p.values, p.parent_block_id, p.column_width));
							case "upload_image": return json(await uploadImageBlock(client, p.doc_token, getMediaMaxBytes(p, defaultAccountId), mediaLocalRoots, p.url, p.file_path, p.parent_block_id, p.filename, p.index, p.image));
							case "upload_file": return json(await uploadFileBlock(client, p.doc_token, getMediaMaxBytes(p, defaultAccountId), mediaLocalRoots, p.url, p.file_path, p.parent_block_id, p.filename));
							case "color_text": return json(await updateColorText(client, p.doc_token, p.block_id, p.content));
							case "insert_table_row": return json(await insertTableRow(client, p.doc_token, p.block_id, p.row_index));
							case "insert_table_column": return json(await insertTableColumn(client, p.doc_token, p.block_id, p.column_index));
							case "delete_table_rows": return json(await deleteTableRows(client, p.doc_token, p.block_id, p.row_start, p.row_count));
							case "delete_table_columns": return json(await deleteTableColumns(client, p.doc_token, p.block_id, p.column_start, p.column_count));
							case "merge_table_cells": return json(await mergeTableCells(client, p.doc_token, p.block_id, p.row_start, p.row_end, p.column_start, p.column_end));
							default: return json({ error: "Unknown action" });
						}
					} catch (err) {
						return json({ error: formatErrorMessage(err) });
					}
				}
			};
		}, { name: "feishu_doc" });
		registered.push("feishu_doc");
	}
	if (toolsCfg.scopes) {
		api.registerTool((ctx) => ({
			name: "feishu_app_scopes",
			label: "Feishu App Scopes",
			description: "List current app permissions (scopes). Use to debug permission issues or check available capabilities.",
			parameters: Type.Object({}),
			async execute() {
				try {
					return json(await listAppScopes(createFeishuToolClient({
						api,
						defaultAccountId: ctx.agentAccountId,
						requiredTool: {
							family: "scopes",
							label: "App Scopes"
						}
					})));
				} catch (err) {
					return json({ error: formatErrorMessage(err) });
				}
			}
		}), { name: "feishu_app_scopes" });
		registered.push("feishu_app_scopes");
	}
}
//#endregion
export { registerFeishuDocTools };
