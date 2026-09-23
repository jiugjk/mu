import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ScriptedReply {
	/** Text, streamed in a few chunks. */
	text?: string;
	/** Tool calls (OpenAI function calls). */
	toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
	/** Delay before each chunk, ms (lets a test observe streaming). */
	chunkDelayMs?: number;
	/** Number of text chunks (default 3). */
	chunks?: number;
}

export interface RecordedRequest {
	messages: Array<{ role: string; content: unknown }>;
	tools?: unknown[];
}

/**
 * An OpenAI-compatible chat completions endpoint that answers from a script. mu's sessions reach it through a
 * models.json provider (api "openai-completions"), the same way they reach Ollama or vLLM: no test hook in mu.
 */
/** One call to the OpenAI-compatible speech-to-text endpoint. */
export interface TranscriptionRequest {
	authorization: string | undefined;
	/** The multipart body, as text (file name, model and the audio bytes). */
	body: string;
}

export class FakeLLM {
	readonly requests: RecordedRequest[] = [];
	readonly transcriptions: TranscriptionRequest[] = [];
	/** What /audio/transcriptions answers. */
	transcript = "这是语音转写的文字";
	private readonly script: ScriptedReply[] = [];
	private server: Server | undefined;
	fallback: ScriptedReply = { text: "好的。" };
	baseUrl = "";

	reply(...replies: ScriptedReply[]): this {
		this.script.push(...replies);
		return this;
	}

	get pending(): number {
		return this.script.length;
	}

	async start(): Promise<void> {
		this.server = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			if ((req.url ?? "").endsWith("/audio/transcriptions")) {
				this.transcriptions.push({
					authorization: req.headers.authorization,
					body: Buffer.concat(chunks).toString("latin1"),
				});
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ text: this.transcript }));
				return;
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as RecordedRequest & {
				stream?: boolean;
			};
			this.requests.push({ messages: body.messages, tools: body.tools });
			const reply = this.script.shift() ?? this.fallback;
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			const write = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
			const base = {
				id: `chatcmpl-${this.requests.length}`,
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "fake-1",
			};
			const pause = () =>
				reply.chunkDelayMs ? new Promise((resolve) => setTimeout(resolve, reply.chunkDelayMs)) : Promise.resolve();
			write({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
			if (reply.text) {
				const parts = Math.max(1, reply.chunks ?? 3);
				const size = Math.ceil(reply.text.length / parts);
				for (let i = 0; i < reply.text.length; i += size) {
					await pause();
					write({
						...base,
						choices: [{ index: 0, delta: { content: reply.text.slice(i, i + size) }, finish_reason: null }],
					});
				}
			}
			reply.toolCalls?.forEach((call, index) => {
				write({
					...base,
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index,
										id: `call_${this.requests.length}_${index}`,
										type: "function",
										function: { name: call.name, arguments: JSON.stringify(call.args) },
									},
								],
							},
							finish_reason: null,
						},
					],
				});
			});
			write({
				...base,
				choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop" }],
			});
			write({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
			res.end("data: [DONE]\n\n");
		});
		await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", () => resolve()));
		this.baseUrl = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}/v1`;
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => this.server?.close(() => resolve()));
	}

	/** The text of every user message the model received in request `index`. */
	userTexts(index = this.requests.length - 1): string[] {
		return (this.requests[index]?.messages ?? [])
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
	}

	systemPrompt(index = this.requests.length - 1): string {
		const first = this.requests[index]?.messages.find((m) => m.role === "system" || m.role === "developer");
		return typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? "");
	}
}
