import { isRecord as isRecord$1 } from "./comment-shared.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
//#region src/post.ts
const FALLBACK_POST_TEXT = "[Rich text message]";
const MARKDOWN_SPECIAL_CHARS = /([\\`*_{}[\]()#+\-!|>~])/g;
function toStringOrEmpty(value) {
	return typeof value === "string" ? value : "";
}
function escapeMarkdownText(text) {
	return text.replace(MARKDOWN_SPECIAL_CHARS, "\\$1");
}
function toBoolean(value) {
	return value === true || value === 1 || value === "true";
}
function isStyleEnabled(style, key) {
	if (!style) return false;
	return toBoolean(style[key]);
}
function wrapInlineCode(text) {
	const maxRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(maxRun + 1);
	return `${fence}${text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text}${fence}`;
}
function sanitizeFenceLanguage(language) {
	return language.trim().replace(/[^A-Za-z0-9_+#.-]/g, "");
}
function renderTextElement(element) {
	const text = toStringOrEmpty(element.text);
	const style = isRecord$1(element.style) ? element.style : void 0;
	if (isStyleEnabled(style, "code")) return wrapInlineCode(text);
	let rendered = escapeMarkdownText(text);
	if (!rendered) return "";
	if (isStyleEnabled(style, "bold")) rendered = `**${rendered}**`;
	if (isStyleEnabled(style, "italic")) rendered = `*${rendered}*`;
	if (isStyleEnabled(style, "underline")) rendered = `<u>${rendered}</u>`;
	if (isStyleEnabled(style, "strikethrough") || isStyleEnabled(style, "line_through") || isStyleEnabled(style, "lineThrough")) rendered = `~~${rendered}~~`;
	return rendered;
}
function renderLinkElement(element) {
	const href = toStringOrEmpty(element.href).trim();
	const text = toStringOrEmpty(element.text) || href;
	if (!text) return "";
	if (!href) return escapeMarkdownText(text);
	return `[${escapeMarkdownText(text)}](${href})`;
}
function renderMentionElement(element) {
	const mention = toStringOrEmpty(element.user_name) || toStringOrEmpty(element.user_id) || toStringOrEmpty(element.open_id);
	if (!mention) return "";
	return `@${escapeMarkdownText(mention)}`;
}
function renderEmotionElement(element) {
	return escapeMarkdownText(toStringOrEmpty(element.emoji) || toStringOrEmpty(element.text) || toStringOrEmpty(element.emoji_type));
}
function renderCodeBlockElement(element) {
	const language = sanitizeFenceLanguage(toStringOrEmpty(element.language) || toStringOrEmpty(element.lang));
	const code = (toStringOrEmpty(element.text) || toStringOrEmpty(element.content)).replace(/\r\n/g, "\n");
	return `\`\`\`${language}\n${code}${code.endsWith("\n") ? "" : "\n"}\`\`\``;
}
function renderElement(element, imageKeys, mediaKeys, mentionedOpenIds) {
	if (!isRecord$1(element)) return escapeMarkdownText(toStringOrEmpty(element));
	switch (normalizeLowercaseStringOrEmpty(toStringOrEmpty(element.tag))) {
		case "text": return renderTextElement(element);
		case "a": return renderLinkElement(element);
		case "at":
			{
				const normalizedMention = normalizeFeishuExternalKey(toStringOrEmpty(element.open_id) || toStringOrEmpty(element.user_id));
				if (normalizedMention) mentionedOpenIds.push(normalizedMention);
			}
			return renderMentionElement(element);
		case "img": {
			const imageKey = normalizeFeishuExternalKey(toStringOrEmpty(element.image_key));
			if (imageKey) imageKeys.push(imageKey);
			return "![image]";
		}
		case "media": {
			const fileKey = normalizeFeishuExternalKey(toStringOrEmpty(element.file_key));
			if (fileKey) {
				const fileName = toStringOrEmpty(element.file_name) || void 0;
				mediaKeys.push({
					fileKey,
					fileName
				});
			}
			return "[media]";
		}
		case "emotion": return renderEmotionElement(element);
		case "md":
		case "lark_md": return toStringOrEmpty(element.text) || toStringOrEmpty(element.content);
		case "br": return "\n";
		case "hr": return "\n\n---\n\n";
		case "code": {
			const code = toStringOrEmpty(element.text) || toStringOrEmpty(element.content);
			return code ? wrapInlineCode(code) : "";
		}
		case "code_block":
		case "pre": return renderCodeBlockElement(element);
		default: return escapeMarkdownText(toStringOrEmpty(element.text));
	}
}
function toPostPayload(candidate) {
	if (!isRecord$1(candidate) || !Array.isArray(candidate.content)) return null;
	return {
		title: toStringOrEmpty(candidate.title),
		content: candidate.content
	};
}
function resolveLocalePayload(candidate) {
	const direct = toPostPayload(candidate);
	if (direct) return direct;
	if (!isRecord$1(candidate)) return null;
	for (const value of Object.values(candidate)) {
		const localePayload = toPostPayload(value);
		if (localePayload) return localePayload;
	}
	return null;
}
function resolvePostPayload(parsed) {
	const direct = toPostPayload(parsed);
	if (direct) return direct;
	if (!isRecord$1(parsed)) return null;
	const wrappedPost = resolveLocalePayload(parsed.post);
	if (wrappedPost) return wrappedPost;
	return resolveLocalePayload(parsed);
}
function parsePostContent(content) {
	try {
		const payload = resolvePostPayload(JSON.parse(content));
		if (!payload) return {
			textContent: FALLBACK_POST_TEXT,
			imageKeys: [],
			mediaKeys: [],
			mentionedOpenIds: []
		};
		const imageKeys = [];
		const mediaKeys = [];
		const mentionedOpenIds = [];
		const paragraphs = [];
		for (const paragraph of payload.content) {
			if (!Array.isArray(paragraph)) continue;
			let renderedParagraph = "";
			for (const element of paragraph) renderedParagraph += renderElement(element, imageKeys, mediaKeys, mentionedOpenIds);
			paragraphs.push(renderedParagraph);
		}
		return {
			textContent: [escapeMarkdownText(payload.title.trim()), paragraphs.join("\n").trim()].filter(Boolean).join("\n\n").trim() || FALLBACK_POST_TEXT,
			imageKeys,
			mediaKeys,
			mentionedOpenIds
		};
	} catch {
		return {
			textContent: FALLBACK_POST_TEXT,
			imageKeys: [],
			mediaKeys: [],
			mentionedOpenIds: []
		};
	}
}
//#endregion
export { parsePostContent };
