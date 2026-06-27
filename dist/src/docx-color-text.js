import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
//#region src/docx-color-text.ts
const TEXT_COLOR = {
	red: 1,
	orange: 2,
	yellow: 3,
	green: 4,
	blue: 5,
	purple: 6,
	grey: 7,
	gray: 7
};
const BACKGROUND_COLOR = {
	red: 1,
	orange: 2,
	yellow: 3,
	green: 4,
	blue: 5,
	purple: 6,
	grey: 7,
	gray: 7
};
/**
* Parse color markup into segments.
*
* Supports:
*   [red]text[/red]               → red text
*   [bg:yellow]text[/bg]          → yellow background
*   [bold]text[/bold]             → bold
*   [green bold]text[/green]      → green + bold
*/
function parseColorMarkup(content) {
	const segments = [];
	const KNOWN = "(?:bg:[a-z]+|bold|red|orange|yellow|green|blue|purple|gr[ae]y)";
	const tagPattern = new RegExp(`\\[(${KNOWN}(?:\\s+${KNOWN})*)\\](.*?)\\[\\/(?:[^\\]]+)\\]|([^[]+|\\[)`, "gis");
	let match;
	while ((match = tagPattern.exec(content)) !== null) if (match[3] !== void 0) {
		if (match[3]) segments.push({ text: match[3] });
	} else {
		const tagStr = normalizeLowercaseStringOrEmpty(match[1]);
		const text = match[2];
		const tags = tagStr.split(/\s+/);
		const segment = { text };
		for (const tag of tags) if (tag.startsWith("bg:")) {
			const color = tag.slice(3);
			if (BACKGROUND_COLOR[color]) segment.bgColor = BACKGROUND_COLOR[color];
		} else if (tag === "bold") segment.bold = true;
		else if (TEXT_COLOR[tag]) segment.textColor = TEXT_COLOR[tag];
		if (text) segments.push(segment);
	}
	return segments;
}
/**
* Update a text block with colored segments.
*/
async function updateColorText(client, docToken, blockId, content) {
	const segments = parseColorMarkup(content);
	const elements = segments.map((seg) => ({ text_run: {
		content: seg.text,
		text_element_style: {
			...seg.textColor && { text_color: seg.textColor },
			...seg.bgColor && { background_color: seg.bgColor },
			...seg.bold && { bold: true }
		}
	} }));
	const res = await client.docx.documentBlock.patch({
		path: {
			document_id: docToken,
			block_id: blockId
		},
		data: { update_text_elements: { elements } }
	});
	if (res.code !== 0) throw new Error(res.msg);
	return {
		success: true,
		segments: segments.length,
		block: res.data?.block
	};
}
//#endregion
export { updateColorText };
