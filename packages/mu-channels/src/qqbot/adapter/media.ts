/**
 * 远程媒体下载
 *
 * mu 适配：原版优先动态加载 openclaw/plugin-sdk/media-runtime（含 SSRF 防护/重试/大小限制），
 * 不可用时降级到原生 fetch。mu 没有 media-runtime，始终使用下面的 fetch 实现（即原版的降级路径）。
 * 下载目录由调用方给出（按会话隔离，见 host.ts conversationDirs）；未给出时落在 ~/.mu/qqbot/media/<subdir>。
 */

import * as crypto from "node:crypto";
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { getQQBotMediaDir } from "../utils/platform.ts";

export interface DownloadOptions {
	url: string;
	/** 目标目录（绝对路径，优先于 subdir） */
	dir?: string;
	subdir?: string;
	originalFilename?: string;
	maxBytes?: number;
	timeoutMs?: number;
}

export function downloadRemoteMedia(opts: DownloadOptions): Promise<{ path: string }> {
	return downloadViaFetch(opts);
}

// ── SSRF 防护 ──

// mu 修正：原版只查 IPv4（resolve4），漏掉 IPv6、IPv4 映射的 IPv6、100.64/10、0.0.0.0/8。
const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	BLOCKED.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const) {
	BLOCKED.addSubnet(address, prefix, "ipv6");
}

function isPrivateAddress(address: string, family: number): boolean {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (mapped?.[1]) return BLOCKED.check(mapped[1], "ipv4");
	return BLOCKED.check(address, family === 6 ? "ipv6" : "ipv4");
}

async function assertSafeHostname(hostname: string): Promise<void> {
	const addresses = await dns.promises.lookup(hostname.replace(/^\[|\]$/g, ""), { all: true }).catch(() => []);
	if (addresses.length === 0) throw new Error(`DNS resolution failed: ${hostname}`);
	for (const { address, family } of addresses) {
		if (isPrivateAddress(address, family)) {
			throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${address}`);
		}
	}
}

// ── 降级 fetch ──

/**
 * 降级：原生 fetch 直连（含 SSRF 防护、大小限制）
 *
 * mu 修正：原版先把整个响应读进内存再比较大小（500MB 的附件先占 500MB 内存，并行下载时叠加），重定向也不再检查。
 * 现在先看 Content-Length，再边下载边计数写盘，超限立即中止并删除；重定向逐跳重新做 HTTPS 与内网检查；
 * 过长的文件名（中文名常见）截短，文件只有属主可读。
 */
async function downloadViaFetch(opts: DownloadOptions): Promise<{ path: string }> {
	const maxBytes = opts.maxBytes ?? 500 * 1024 * 1024;
	const signal = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
	let url = new URL(opts.url);
	let resp: Response | undefined;
	for (let hop = 0; hop <= 3; hop++) {
		if (url.protocol !== "https:") throw new Error(`Only HTTPS allowed: ${url.protocol}`);
		await assertSafeHostname(url.hostname);
		resp = await fetch(url, { signal, redirect: "manual" });
		const location = resp.status >= 300 && resp.status < 400 ? resp.headers.get("location") : null;
		if (!location) break;
		await resp.body?.cancel();
		url = new URL(location, url);
		resp = undefined;
	}
	if (!resp) throw new Error("Download: too many redirects");
	if (!resp.ok) throw new Error(`Download HTTP ${resp.status}`);
	const tooBig = () => new Error(`Download exceeds ${(maxBytes / 1024 / 1024).toFixed(0)}MB`);
	if (Number(resp.headers.get("content-length") ?? 0) > maxBytes) {
		await resp.body?.cancel();
		throw tooBig();
	}

	const dir = opts.dir ?? getQQBotMediaDir(opts.subdir ?? "downloads");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const ext = opts.originalFilename ? (path.extname(opts.originalFilename) || ".bin").slice(0, 16) : ".bin";
	// mu 修正：文件名来自 QQ 事件，去掉路径分隔与控制字符后再落盘
	const name = opts.originalFilename
		? [...path.basename(opts.originalFilename, path.extname(opts.originalFilename)).replace(/[\\/\x00-\x1f]/g, "_")]
				.slice(0, 60)
				.join("")
		: "download";
	const rand = crypto.randomBytes(4).toString("hex");
	const filePath = path.join(dir, `${name}_${Date.now()}_${rand}${ext}`);

	const body = resp.body;
	if (!body) throw new Error("Download: empty response");
	let received = 0;
	try {
		await pipeline(
			body,
			async function* (source: AsyncIterable<Uint8Array>) {
				for await (const chunk of source) {
					received += chunk.byteLength;
					if (received > maxBytes) throw tooBig();
					yield chunk;
				}
			},
			fs.createWriteStream(filePath, { mode: 0o600 }),
		);
	} catch (err) {
		fs.rmSync(filePath, { force: true });
		throw err;
	}
	return { path: filePath };
}
