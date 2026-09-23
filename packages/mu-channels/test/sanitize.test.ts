/**
 * sanitizeQQBotText 单元测试（移植自 openclaw-qqbot tests/sanitize.test.ts）
 *
 * 用例原样保留；原文件是 tsx 脚本（自带 test() 计数器与 process.exit），移植为 vitest：
 * test / testContains 各注册一个 vitest 用例（原文件的 testNotContains 未被任何用例使用，未移植）。
 */
import { expect, it } from "vitest";
import { sanitizeQQBotText } from "../src/qqbot/outbound/sanitize.ts";

function test(name: string, input: string, expected: string) {
	it(name, () => expect(sanitizeQQBotText(input)).toBe(expected));
}

function testContains(name: string, input: string, expectedSubstring: string) {
	it(name, () => expect(sanitizeQQBotText(input)).toContain(expectedSubstring));
}

// ======================================================================
//  Part 1: 框架脚手架标签剥离
// ======================================================================
// 1. 框架脚手架标签

test("system-reminder 完整块剥离", "<system-reminder>请保持友好。</system-reminder>你好", "你好");
test("system-reminder 带属性", '<system-reminder type="note">内容</system-reminder>正文', "正文");
test("previous_response 块剥离", "<previous_response>上一轮对话内容</previous_response>新消息", "新消息");
test("system-reminder 自闭和标签", "<system-reminder/>正文", "正文");
test("无脚手架标签的纯文本", "这是一条普通消息", "这是一条普通消息");

// ======================================================================
//  Part 2: deepseek `think`...`/think` 推理块剥离
// ======================================================================
// 2. deepseek think 块

test("完整 think 块", "`think`好的，让我来帮你分析这个问题...`/think`这是最终回答。", "这是最终回答。");
test("think 块在开头", "`think`思考中...`/think`你好，世界！", "你好，世界！");
test("think 块在结尾", "这是回答。`think`再确认一下...`/think`", "这是回答。");
test("多行内容的 think 块", "`think`第一行思考\n第二行思考\n第三行思考`/think`最终回答", "最终回答");
test("think 块中间带内容", "前面文字`think`推理...`/think`后面文字", "前面文字后面文字");
test("两个 think 块", "`think`第一步`/think``think`第二步`/think`回答", "回答");

// 未匹配完整 `think`...`/think` 模式的文本保留原样
test("不完整的 think 标签（无闭合）— 保留原文", "正文`think`半截思考", "正文`think`半截思考");
test("不完整的闭合标签（无开标签）— 保留原文", "正文`/think`其他", "正文`/think`其他");
test("普通反引号文本（非 think 标签）— 保留原文", "正文`普通代码`后续", "正文`普通代码`后续");

// ======================================================================
//  Part 3: claude <thinking> 推理块剥离
// ======================================================================
// 3. claude thinking 块

test("<thinking> 完整块", "<thinking>我需要先分析用户意图。</thinking>回答内容", "回答内容");
test("<thinking> 带属性", '<thinking level="low">快速思考</thinking>正文', "正文");
test("<thinking/> 自闭和", "<thinking/>正文", "正文");
test("<thinking> 不完整块 — 仅剥离标签", "<thinking>未闭合", "未闭合");

// ======================================================================
//  Part 4: <think> 标签（deepseek beta 格式）
// ======================================================================
// 4. <think> 标签

test("<think> 自闭和", "<think/>正文", "正文");
test("<think> 开标签（内容可能无闭合）", "<think>推理中", "推理中");
test("<think> 未闭合块 — 剥离标签保留文本", "<think>部分推理内容", "部分推理内容");

// ======================================================================
//  Part 5: Markdown 内联代码保留（核心回归测试）
// ======================================================================
// 5. Markdown 内联代码不被误杀

test("单反引号内联代码保留", "你可以用 `console.log('hello')` 来调试", "你可以用 `console.log('hello')` 来调试");
test("多对内联代码", "用 `npm install` 安装，然后 `npm start` 启动", "用 `npm install` 安装，然后 `npm start` 启动");
test("代码内容含 think 词仍保留（是内联代码，不是 think 标签）", "用 `think` 函数处理", "用 `think` 函数处理");
test("代码内容含 thinking 词仍保留", "用 `thinking` 这个变量", "用 `thinking` 这个变量");

// ======================================================================
//  Part 6: 代码围栏（三反引号）不应被误杀
// ======================================================================
// 6. 三反引号代码块保留

testContains("三反引号代码块完整保留", "```\ncode block content\n```", "```");
testContains("带语言标识的代码块", "```javascript\nconst x = 1;\n```", "```javascript");
testContains("围栏内含 'think' 词但不是 think 标签", "```\nlet think = true;\n```", "let think = true;");

// ======================================================================
//  Part 7: 复合场景
// ======================================================================
// 7. 复合场景

test(
	"think 块 + scaffolding 标签",
	"`think`分析中...`/think`<system-reminder>注意语气</system-reminder>最终回答",
	"最终回答",
);
test("thinking 块 + think 块", "<thinking>claude思考</thinking>`think`deepseek思考`/think`最终回答", "最终回答");
test(
	"内联代码 + think 块共存",
	"`think`deepseek分析...`/think`你可以用 `console.log` 调试",
	"你可以用 `console.log` 调试",
);

// ======================================================================
//  Part 8: 边界场景
// ======================================================================
// 8. 边界场景

test("空字符串", "", "");
test("空白字符", "   ", "");
test("纯 backtick 文本（无 think 标签名）", "`不是think标签`", "`不是think标签`");
test("纯 HTML think 标签字符串", "<thinking>思考</thinking>", "");
test("纯 think 块（backtick 格式）", "`think`我是推理内容`/think`", "");
test("think 块前后有换行", "\n`think`思考...`/think`\n回答\n", "回答");

// ======================================================================
//  结果汇总
// ======================================================================
