import { requestFeishuApi } from "./comment-shared.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { assertFeishuMessageApiSuccess, resolveFeishuReceiptKind, toFeishuSendResult } from "./send-result.js";
import { getFeishuRuntime } from "./runtime.js";
import { createFeishuClient } from "./client.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { resolveFeishuSendTarget } from "./send-target.js";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import fs from "node:fs";
import path from "node:path";
import { mediaKindFromMime } from "openclaw/plugin-sdk/media-mime";
import { MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS, runFfmpeg } from "openclaw/plugin-sdk/media-runtime";
import { Readable } from "node:stream";
import { saveMediaBuffer, saveMediaStream } from "openclaw/plugin-sdk/media-store";
import { readRegularFile, writeExternalFileWithinRoot } from "openclaw/plugin-sdk/security-runtime";
import { resolvePreferredOpenClawTmpDir, withTempDownloadPath, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
//#region src/media.ts
const FEISHU_MEDIA_HTTP_TIMEOUT_MS = 12e4;
const FEISHU_VOICE_FILE_NAME = "voice.ogg";
const FEISHU_VOICE_SAMPLE_RATE_HZ = 48e3;
const FEISHU_VOICE_BITRATE = "64k";
const FEISHU_TRANSCODABLE_AUDIO_EXTS = /* @__PURE__ */ new Set([
	".aac",
	".aiff",
	".alac",
	".amr",
	".caf",
	".flac",
	".m4a",
	".mp3",
	".oga",
	".wav",
	".webm",
	".wma"
]);
function createConfiguredFeishuMediaClient(params) {
	const account = resolveFeishuRuntimeAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	return {
		account,
		client: createFeishuClient({
			...account,
			httpTimeoutMs: FEISHU_MEDIA_HTTP_TIMEOUT_MS
		})
	};
}
function asHeaderMap(value) {
	if (!value) return;
	const entries = Object.entries(value);
	if (entries.every(([, entry]) => typeof entry === "string" || Array.isArray(entry))) return Object.fromEntries(entries);
}
function extractFeishuUploadKey(response, params) {
	if (!response) throw new Error(`${params.errorPrefix}: empty response`);
	const wrappedResponse = response;
	if (wrappedResponse.code !== void 0 && wrappedResponse.code !== 0) throw new Error(`${params.errorPrefix}: ${wrappedResponse.msg || `code ${wrappedResponse.code}`}`);
	const key = params.key === "image_key" ? wrappedResponse.image_key ?? wrappedResponse.data?.image_key : wrappedResponse.file_key ?? wrappedResponse.data?.file_key;
	if (!key) throw new Error(`${params.errorPrefix}: no ${params.key} returned`);
	return key;
}
function readHeaderValue(headers, name) {
	if (!headers) return;
	for (const [key, value] of Object.entries(headers)) {
		if (normalizeLowercaseStringOrEmpty(key) !== normalizeLowercaseStringOrEmpty(name)) continue;
		if (typeof value === "string" && value.trim()) return value.trim();
		if (Array.isArray(value)) {
			const first = value.find((entry) => typeof entry === "string" && entry.trim());
			if (typeof first === "string") return first.trim();
		}
	}
}
function readHttpStatusFromError(error) {
	if (!error || typeof error !== "object") return;
	const response = error.response;
	if (response && typeof response === "object") {
		const status = response.status;
		if (typeof status === "number") return status;
	}
	const status = error.status;
	return typeof status === "number" ? status : void 0;
}
function isHttpStatusError(error, status) {
	return readHttpStatusFromError(error) === status;
}
function containsEastAsianScript(value) {
	return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value);
}
function recoverUtf8FileNameFromLatin1Header(value) {
	const recovered = Buffer.from(value, "latin1").toString("utf8");
	if (recovered !== value && !recovered.includes("�") && containsEastAsianScript(recovered)) return recovered;
	return value;
}
function decodeDispositionFileName(value) {
	const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
	if (utf8Match?.[1]) try {
		return decodeURIComponent(utf8Match[1].trim().replace(/^"(.*)"$/, "$1"));
	} catch {
		return utf8Match[1].trim().replace(/^"(.*)"$/, "$1");
	}
	const plainFileName = value.match(/filename="?([^";]+)"?/i)?.[1]?.trim();
	return plainFileName ? recoverUtf8FileNameFromLatin1Header(plainFileName) : void 0;
}
function extractFeishuDownloadMetadata(response) {
	const responseWithOptionalFields = response;
	const headers = asHeaderMap(responseWithOptionalFields.headers) ?? asHeaderMap(responseWithOptionalFields.header);
	const contentType = readHeaderValue(headers, "content-type") ?? responseWithOptionalFields.contentType ?? responseWithOptionalFields.mime_type ?? responseWithOptionalFields.data?.contentType ?? responseWithOptionalFields.data?.mime_type;
	const disposition = readHeaderValue(headers, "content-disposition");
	return {
		contentType,
		fileName: (disposition ? decodeDispositionFileName(disposition) : void 0) ?? responseWithOptionalFields.file_name ?? responseWithOptionalFields.fileName ?? responseWithOptionalFields.data?.file_name ?? responseWithOptionalFields.data?.fileName
	};
}
function mediaLimitError(maxBytes) {
	return /* @__PURE__ */ new Error(`Media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
}
async function saveFeishuResponseMedia(params) {
	const { response, maxBytes, contentType, fileName } = params;
	if (Buffer.isBuffer(response)) return saveMediaBuffer(response, contentType, "inbound", maxBytes, fileName);
	if (response instanceof ArrayBuffer) return saveMediaBuffer(Buffer.from(response), contentType, "inbound", maxBytes, fileName);
	const responseWithOptionalFields = response;
	if (responseWithOptionalFields.code !== void 0 && responseWithOptionalFields.code !== 0) throw new Error(`${params.errorPrefix}: ${responseWithOptionalFields.msg || `code ${responseWithOptionalFields.code}`}`);
	if (responseWithOptionalFields.data && Buffer.isBuffer(responseWithOptionalFields.data)) return saveMediaBuffer(responseWithOptionalFields.data, contentType, "inbound", maxBytes, fileName);
	if (responseWithOptionalFields.data instanceof ArrayBuffer) return saveMediaBuffer(Buffer.from(responseWithOptionalFields.data), contentType, "inbound", maxBytes, fileName);
	if (typeof response.getReadableStream === "function") return saveMediaStream(response.getReadableStream(), contentType, "inbound", maxBytes, fileName);
	if (typeof response.writeFile === "function") return await withTempDownloadPath({ prefix: params.tmpDirPrefix }, async (tmpPath) => {
		await response.writeFile(tmpPath);
		if ((await fs.promises.stat(tmpPath)).size > maxBytes) throw mediaLimitError(maxBytes);
		return await saveMediaStream(fs.createReadStream(tmpPath), contentType, "inbound", maxBytes, fileName);
	});
	if (responseWithOptionalFields[Symbol.asyncIterator]) return saveMediaStream(responseWithOptionalFields, contentType, "inbound", maxBytes, fileName);
	if (response instanceof Readable) return saveMediaStream(response, contentType, "inbound", maxBytes, fileName);
	const keys = Object.keys(response);
	throw new Error(`${params.errorPrefix}: unexpected response format. Keys: [${keys.join(", ")}]`);
}
async function saveMessageResourceWithType(params) {
	const response = await params.client.im.messageResource.get({
		path: {
			message_id: params.messageId,
			file_key: params.fileKey
		},
		params: { type: params.type }
	});
	const meta = extractFeishuDownloadMetadata(response);
	return {
		saved: await saveFeishuResponseMedia({
			response,
			tmpDirPrefix: "openclaw-feishu-resource-",
			errorPrefix: "Feishu message resource download failed",
			maxBytes: params.maxBytes,
			contentType: meta.contentType,
			fileName: meta.fileName ?? (params.originalFilename ? recoverUtf8FileNameFromLatin1Header(params.originalFilename) : void 0)
		}),
		...meta
	};
}
async function saveMessageResourceFeishu(params) {
	const { cfg, messageId, fileKey, type, accountId, maxBytes, originalFilename } = params;
	const normalizedFileKey = normalizeFeishuExternalKey(fileKey);
	if (!normalizedFileKey) throw new Error("Feishu message resource download failed: invalid file_key");
	const { client } = createConfiguredFeishuMediaClient({
		cfg,
		accountId
	});
	try {
		return await saveMessageResourceWithType({
			client,
			messageId,
			fileKey: normalizedFileKey,
			type,
			maxBytes,
			originalFilename
		});
	} catch (err) {
		if (type !== "file" || !isHttpStatusError(err, 502)) throw err;
		try {
			return await saveMessageResourceWithType({
				client,
				messageId,
				fileKey: normalizedFileKey,
				type: "media",
				maxBytes,
				originalFilename
			});
		} catch {
			throw err;
		}
	}
}
/**
* Upload an image to Feishu and get an image_key for sending.
* Supports: JPEG, PNG, WEBP, GIF, TIFF, BMP, ICO
*/
async function uploadImageFeishu(params) {
	const { cfg, image, imageType = "message", accountId } = params;
	const { client } = createConfiguredFeishuMediaClient({
		cfg,
		accountId
	});
	const imageData = typeof image === "string" ? (await readRegularFile({ filePath: image })).buffer : image;
	return { imageKey: extractFeishuUploadKey(await requestFeishuApi(() => client.im.image.create({ data: {
		image_type: imageType,
		image: imageData
	} }), "Feishu image upload failed", { includeNestedErrorLogId: true }), {
		key: "image_key",
		errorPrefix: "Feishu image upload failed"
	}) };
}
/**
* Sanitize a filename for safe use in Feishu multipart/form-data uploads.
* Strips control characters and multipart-injection vectors (CWE-93) while
* preserving the original UTF-8 display name (Chinese, emoji, etc.).
*
* Previous versions percent-encoded non-ASCII characters, but the Feishu
* `im.file.create` API uses `file_name` as a literal display name — it does
* NOT decode percent-encoding — so encoded filenames appeared as garbled text
* in chat (regression in v2026.3.2).
*/
function sanitizeFileNameForUpload(fileName) {
	return fileName.replace(/[\p{Cc}"\\]/gu, "_");
}
/**
* Upload a file to Feishu and get a file_key for sending.
* Max file size: 30MB
*/
async function uploadFileFeishu(params) {
	const { cfg, file, fileName, fileType, duration, accountId } = params;
	const { client } = createConfiguredFeishuMediaClient({
		cfg,
		accountId
	});
	const fileData = typeof file === "string" ? (await readRegularFile({ filePath: file })).buffer : file;
	const safeFileName = sanitizeFileNameForUpload(fileName);
	return { fileKey: extractFeishuUploadKey(await requestFeishuApi(() => client.im.file.create({ data: {
		file_type: fileType,
		file_name: safeFileName,
		file: fileData,
		...duration !== void 0 && { duration }
	} }), "Feishu file upload failed", { includeNestedErrorLogId: true }), {
		key: "file_key",
		errorPrefix: "Feishu file upload failed"
	}) };
}
/**
* Send an image message using an image_key
*/
async function sendImageFeishu(params) {
	const { cfg, to, imageKey, replyToMessageId, replyInThread, accountId } = params;
	const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
		cfg,
		to,
		accountId
	});
	const content = JSON.stringify({ image_key: imageKey });
	if (replyToMessageId) {
		const response = await requestFeishuApi(() => client.im.message.reply({
			path: { message_id: replyToMessageId },
			data: {
				content,
				msg_type: "image",
				...replyInThread ? { reply_in_thread: true } : {}
			}
		}), "Feishu image reply failed", { includeNestedErrorLogId: true });
		assertFeishuMessageApiSuccess(response, "Feishu image reply failed");
		return toFeishuSendResult(response, receiveId, "media");
	}
	const response = await requestFeishuApi(() => client.im.message.create({
		params: { receive_id_type: receiveIdType },
		data: {
			receive_id: receiveId,
			content,
			msg_type: "image"
		}
	}), "Feishu image send failed", { includeNestedErrorLogId: true });
	assertFeishuMessageApiSuccess(response, "Feishu image send failed");
	return toFeishuSendResult(response, receiveId, "media");
}
/**
* Send a file message using a file_key
*/
async function sendFileFeishu(params) {
	const { cfg, to, fileKey, replyToMessageId, replyInThread, accountId } = params;
	const msgType = params.msgType ?? "file";
	const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
		cfg,
		to,
		accountId
	});
	const content = JSON.stringify({ file_key: fileKey });
	if (replyToMessageId) {
		const response = await requestFeishuApi(() => client.im.message.reply({
			path: { message_id: replyToMessageId },
			data: {
				content,
				msg_type: msgType,
				...replyInThread ? { reply_in_thread: true } : {}
			}
		}), "Feishu file reply failed", { includeNestedErrorLogId: true });
		assertFeishuMessageApiSuccess(response, "Feishu file reply failed");
		return toFeishuSendResult(response, receiveId, resolveFeishuReceiptKind(msgType));
	}
	const response = await requestFeishuApi(() => client.im.message.create({
		params: { receive_id_type: receiveIdType },
		data: {
			receive_id: receiveId,
			content,
			msg_type: msgType
		}
	}), "Feishu file send failed", { includeNestedErrorLogId: true });
	assertFeishuMessageApiSuccess(response, "Feishu file send failed");
	return toFeishuSendResult(response, receiveId, resolveFeishuReceiptKind(msgType));
}
/**
* Helper to detect file type from extension
*/
function detectFileType(fileName) {
	switch (normalizeLowercaseStringOrEmpty(path.extname(fileName))) {
		case ".opus":
		case ".ogg": return "opus";
		case ".mp4":
		case ".mov":
		case ".avi": return "mp4";
		case ".pdf": return "pdf";
		case ".doc":
		case ".docx": return "doc";
		case ".xls":
		case ".xlsx": return "xls";
		case ".ppt":
		case ".pptx": return "ppt";
		default: return "stream";
	}
}
function resolveFeishuOutboundMediaKind(params) {
	const { fileName, contentType } = params;
	const ext = normalizeLowercaseStringOrEmpty(path.extname(fileName));
	const mimeKind = mediaKindFromMime(contentType);
	if ([
		".jpg",
		".jpeg",
		".png",
		".gif",
		".webp",
		".bmp",
		".ico",
		".tiff"
	].includes(ext) || mimeKind === "image") return { msgType: "image" };
	if (ext === ".opus" || ext === ".ogg" || contentType === "audio/ogg" || contentType === "audio/opus") return {
		fileType: "opus",
		msgType: "audio"
	};
	if ([
		".mp4",
		".mov",
		".avi"
	].includes(ext) || contentType === "video/mp4" || contentType === "video/quicktime" || contentType === "video/x-msvideo") return {
		fileType: "mp4",
		msgType: "media"
	};
	const fileType = detectFileType(fileName);
	return {
		fileType,
		msgType: fileType === "stream" ? "file" : fileType === "opus" ? "audio" : fileType === "mp4" ? "media" : "file"
	};
}
function isFeishuNativeVoiceAudio(params) {
	const ext = normalizeLowercaseStringOrEmpty(path.extname(params.fileName));
	const contentType = normalizeLowercaseStringOrEmpty(params.contentType);
	return ext === ".opus" || ext === ".ogg" || contentType === "audio/ogg" || contentType === "audio/opus";
}
function normalizeMediaNameForExtension(raw) {
	try {
		return new URL(raw).pathname;
	} catch {
		return raw.split(/[?#]/, 1)[0] ?? raw;
	}
}
function shouldSuppressFeishuTextForVoiceMedia(params) {
	if (params.audioAsVoice === true) return true;
	if (params.fileName && isFeishuNativeVoiceAudio({
		fileName: params.fileName,
		contentType: params.contentType
	})) return true;
	if (!params.mediaUrl) return false;
	return isFeishuNativeVoiceAudio({
		fileName: normalizeMediaNameForExtension(params.mediaUrl),
		contentType: params.contentType
	});
}
function isLikelyTranscodableAudio(params) {
	const ext = normalizeLowercaseStringOrEmpty(path.extname(params.fileName));
	const contentType = normalizeLowercaseStringOrEmpty(params.contentType);
	return FEISHU_TRANSCODABLE_AUDIO_EXTS.has(ext) || mediaKindFromMime(contentType) === "audio";
}
async function transcodeToFeishuVoiceOpus(params) {
	return await withTempWorkspace({
		rootDir: resolvePreferredOpenClawTmpDir(),
		prefix: "feishu-voice-"
	}, async (workspace) => {
		const ext = normalizeLowercaseStringOrEmpty(path.extname(params.fileName));
		const inputExt = ext && ext.length <= 12 ? ext : ".audio";
		const inputPath = await workspace.write(`input${inputExt}`, params.buffer);
		await writeExternalFileWithinRoot({
			rootDir: workspace.dir,
			path: FEISHU_VOICE_FILE_NAME,
			write: async (outputPath) => {
				await runFfmpeg([
					"-hide_banner",
					"-loglevel",
					"error",
					"-y",
					"-i",
					inputPath,
					"-vn",
					"-sn",
					"-dn",
					"-t",
					String(MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS),
					"-ar",
					String(FEISHU_VOICE_SAMPLE_RATE_HZ),
					"-ac",
					"1",
					"-c:a",
					"libopus",
					"-b:a",
					FEISHU_VOICE_BITRATE,
					"-f",
					"ogg",
					outputPath
				]);
			}
		});
		return {
			buffer: await workspace.read(FEISHU_VOICE_FILE_NAME),
			fileName: FEISHU_VOICE_FILE_NAME,
			contentType: "audio/ogg"
		};
	});
}
async function prepareFeishuVoiceMedia(params) {
	if (isFeishuNativeVoiceAudio(params)) return params;
	if (params.audioAsVoice !== true || !isLikelyTranscodableAudio(params)) return params;
	try {
		return await transcodeToFeishuVoiceOpus(params);
	} catch (err) {
		console.warn(`[feishu] audioAsVoice transcode failed; sending ${params.fileName} as a file attachment:`, err);
		return params;
	}
}
/**
* Upload and send media (image or file) from URL, local path, or buffer.
* When mediaUrl is a local path, mediaLocalRoots (from core outbound context)
* must be passed so loadWebMedia allows the path (post CVE-2026-26321).
*/
async function sendMediaFeishu(params) {
	const { cfg, to, mediaUrl, mediaBuffer, fileName, replyToMessageId, replyInThread, accountId, mediaLocalRoots, audioAsVoice } = params;
	const account = resolveFeishuRuntimeAccount({
		cfg,
		accountId
	});
	if (!account.configured) throw new Error(`Feishu account "${account.accountId}" not configured`);
	const mediaMaxBytes = (account.config?.mediaMaxMb ?? 30) * 1024 * 1024;
	let buffer;
	let name;
	let contentType;
	if (mediaBuffer) {
		buffer = mediaBuffer;
		name = fileName ?? "file";
	} else if (mediaUrl) {
		const loaded = await getFeishuRuntime().media.loadWebMedia(mediaUrl, {
			maxBytes: mediaMaxBytes,
			optimizeImages: false,
			localRoots: mediaLocalRoots?.length ? mediaLocalRoots : void 0
		});
		buffer = loaded.buffer;
		name = fileName ?? loaded.fileName ?? "file";
		contentType = loaded.contentType;
	} else throw new Error("Either mediaUrl or mediaBuffer must be provided");
	const prepared = await prepareFeishuVoiceMedia({
		buffer,
		fileName: name,
		contentType,
		audioAsVoice
	});
	buffer = prepared.buffer;
	name = prepared.fileName;
	contentType = prepared.contentType;
	const routing = resolveFeishuOutboundMediaKind({
		fileName: name,
		contentType
	});
	const voiceIntentDegradedToFile = audioAsVoice === true && routing.msgType !== "audio";
	if (routing.msgType === "image") {
		const { imageKey } = await uploadImageFeishu({
			cfg,
			image: buffer,
			accountId
		});
		return {
			...await sendImageFeishu({
				cfg,
				to,
				imageKey,
				replyToMessageId,
				replyInThread,
				accountId
			}),
			...voiceIntentDegradedToFile ? { voiceIntentDegradedToFile: true } : {}
		};
	}
	const { fileKey } = await uploadFileFeishu({
		cfg,
		file: buffer,
		fileName: name,
		fileType: routing.fileType ?? "stream",
		accountId
	});
	return {
		...await sendFileFeishu({
			cfg,
			to,
			fileKey,
			msgType: routing.msgType,
			replyToMessageId,
			replyInThread,
			accountId
		}),
		...voiceIntentDegradedToFile ? { voiceIntentDegradedToFile: true } : {}
	};
}
//#endregion
export { detectFileType, sanitizeFileNameForUpload, saveMessageResourceFeishu, sendFileFeishu, sendImageFeishu, sendMediaFeishu, shouldSuppressFeishuTextForVoiceMedia, uploadFileFeishu, uploadImageFeishu };
