/**
 * GFM 表格 chunker 单元测试（移植自 openclaw-qqbot tests/chunker-table.test.ts）
 *
 * 原文件内联复制了 channel.ts 的 fallback chunker；移植后直接测试 src/qqbot/channel.ts 导出的 chunkText
 * （mu 中没有框架 chunker，该实现即实际使用的切分）。用例原样保留，eq / tableSafe 各注册一个 vitest 用例。
 */
import { expect, it } from "vitest";
import { chunkText, fitChunks } from "../src/qqbot/channel.ts";

const GFM_TABLE_SEP_RE = /^\|[\s:-]+\|/;

function eq(name: string, input: string, limit: number, expectedBlocks: number) {
	it(name, () => expect(chunkText(input, limit)).toHaveLength(expectedBlocks));
}

function tableSafe(name: string, input: string, limit: number) {
	it(name, () => {
		const result = chunkText(input, limit);
		// 验证分隔行没有被孤立（至少旁边有数据行）
		for (let i = 0; i < result.length; i++) {
			const lines = result[i].split("\n");
			for (let j = 0; j < lines.length; j++) {
				if (GFM_TABLE_SEP_RE.test(lines[j])) {
					expect(j > 0 || lines.length > 1, `分隔行不应单独存在 chunk[${i}]`).toBe(true);
				}
			}
		}
	});
}

// ======================================================================
// 1. 表格保持完整（未拆分）

eq("简单 2x2 表格 + 前后文本", "前文\n| A | B |\n|---|---|\n| 1 | 2 |\n后文", 200, 1);
eq("3列表格不超过 limit", "| 名称 | 价格 | 数量 |\n|------|------|------|\n| 苹果 | 5 | 10 |", 250, 1);

// ======================================================================
// 2. 表格独立成块（前文本超出 limit）

eq("大段前文 → 表格独立成块", `${"A".repeat(180)}\n| ID | Name |\n|----|------|\n| 1  | Foo  |`, 150, 2);

eq("表格前后均有大段文本 → 3块", `${"B".repeat(200)}\n| X | Y |\n|----|----|\n| a  | b  |\n${"C".repeat(200)}`, 150, 3);

// ======================================================================
// 3. GFM 分隔行变体

eq("单破折号 |-|-|", "| A | B |\n|-|-|\n| 1 | 2 |", 100, 1);

eq("对齐冒号 |:---|:---:|", "| Left | Center |\n|:-----|:------:|\n| a    | b      |", 200, 1);

eq("多破折号 |------|------|", "| Col1 | Col2 |\n|------|------|\n| v1   | v2   |", 200, 1);

// ======================================================================
// 4. 多个表格共存

eq(
	"两个表格独立",
	"| T1 | V1 |\n|----|----|\n| a  | 1  |\n\n中间\n\n| T2 | V2 |\n|----|----|\n| b  | 2  |",
	200,
	1, // all fits in one chunk
);

eq("两个表格间有大段文字 → 分块", `| H1 |\n|----|\n| d1 |\n${"X".repeat(300)}\n| H2 |\n|----|\n| d2 |`, 200, 3);

// ======================================================================
// 5. 非表格竖线文本不误判

it("普通竖线文本不误判", () => {
	const text = "普通 | 文本\n没有表格分隔行";
	const r = chunkText(text, 50);
	expect(r.join("") === text || r.join("\n") === text, "非表格保持原样").toBe(true);
});

// ======================================================================
// 6. 表格语义校验（分隔行不孤立）

tableSafe("表格分隔行有前后数据行", "前文\n| A | B |\n|---|---|\n| 1 | 2 |\n后文", 200);

// ======================================================================
// 7. 边界场景

eq("纯表格无其他文本", "| H | V |\n|---|---|\n| d | v |", 100, 1);
eq("表格在 limit 内", "开头\n| H | V |\n|---|---|\n| d | v |\n结尾", 100, 1);

// ======================================================================

// ======================================================================
// mu 修正：发送前的最后一道（fitChunks）——超限的段硬切，切开的代码块两边补齐围栏

it("fitChunks: 超过上限的单行被切开，不拆 UTF-16 代理对", () => {
	const pieces = fitChunks(["a".repeat(120)], 50);
	expect(pieces.every((p) => p.length <= 50)).toBe(true);
	expect(pieces.join("")).toBe("a".repeat(120));
	const emoji = fitChunks(["😀".repeat(40)], 50);
	expect(emoji.join("")).toBe("😀".repeat(40));
	expect(emoji.every((p) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p))).toBe(true);
});

it("fitChunks: 被切开的代码块在两段里都是完整的代码块", () => {
	const pieces = fitChunks([`intro\n\`\`\`ts\n${"x\n".repeat(40)}\`\`\`\nend`], 60);
	expect(pieces.length).toBeGreaterThan(1);
	for (const piece of pieces) {
		expect((piece.match(/^```/gm) ?? []).length % 2).toBe(0);
	}
	expect(pieces[1]?.startsWith("```ts\n")).toBe(true);
});
