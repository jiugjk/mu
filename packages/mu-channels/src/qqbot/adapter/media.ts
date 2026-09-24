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
import * as path from "node:path";
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

const PRIVATE_RANGES: Array<[netmask: bigint, prefix: number]> = [
	[0x0a000000n, 8], // 10.0.0.0/8
	[0xac100000n, 12], // 172.16.0.0/12
	[0xc0a80000n, 16], // 192.168.0.0/16
	[0x7f000000n, 8], // 127.0.0.0/8
	[0xa9fe0000n, 16], // 169.254.0.0/16
	[0xe0000000n, 4], // 224.0.0.0/4 (multicast)
];

function ipToBigInt(ip: string): bigint {
	return ip.split(".").reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

function isPrivateIP(ip: string): boolean {
	const val = ipToBigInt(ip);
	return PRIVATE_RANGES.some(([mask, prefix]) => val >> (32n - BigInt(prefix)) === mask >> (32n - BigInt(prefix)));
}

async function assertSafeHostname(hostname: string): Promise<void> {
	const addresses = await dns.promises.resolve4(hostname).catch(() => []);
	if (addresses.length === 0) throw new Error(`DNS resolution failed: ${hostname}`);
	for (const addr of addresses) {
		if (isPrivateIP(addr)) {
			throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${addr}`);
		}
	}
}

// ── 降级 fetch ──

/** 降级：原生 fetch 直连（含 SSRF 防护、大小限制） */
async function downloadViaFetch(opts: DownloadOptions): Promise<{ path: string }> {
	const parsed = new URL(opts.url);
	if (parsed.protocol !== "https:") {
		throw new Error(`Only HTTPS allowed: ${parsed.protocol}`);
	}
	await assertSafeHostname(parsed.hostname);

	const dir = opts.dir ?? getQQBotMediaDir(opts.subdir ?? "downloads");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

	const resp = await fetch(opts.url, {
		signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
	});
	if (!resp.ok) throw new Error(`Download HTTP ${resp.status}`);

	const maxBytes = opts.maxBytes ?? 500 * 1024 * 1024;
	const buf = Buffer.from(await resp.arrayBuffer());
	if (buf.length > maxBytes) throw new Error(`Download exceeds ${(maxBytes / 1024 / 1024).toFixed(0)}MB`);

	const ext = opts.originalFilename ? path.extname(opts.originalFilename) || ".bin" : ".bin";
	// mu 修正：文件名来自 QQ 事件，去掉路径分隔与控制字符后再落盘
	const name = opts.originalFilename
		? path.basename(opts.originalFilename, path.extname(opts.originalFilename)).replace(/[\\/\x00-\x1f]/g, "_")
		: "download";
	const rand = crypto.randomBytes(4).toString("hex");
	const filePath = path.join(dir, `${name}_${Date.now()}_${rand}${ext}`);
	fs.writeFileSync(filePath, buf);
	return { path: filePath };
}
