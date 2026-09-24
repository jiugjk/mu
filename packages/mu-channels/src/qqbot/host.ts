/**
 * QQ 会话宿主（mu 移植新增）
 *
 * 原版把每条消息交给 OpenClaw 的 inbound.run / dispatchReplyWithBufferedBlockDispatcher，由框架按
 * resolveAgentRoute 的 sessionKey 找到会话。移植后每个会话（账户 × 私聊用户 / 群）对应一个 mu 会话，
 * 由通用渠道宿主（src/host）打开、复用、闲置回收；本文件只负责 QQ 相关的部分：
 *   - 会话键与目录隔离：每个私聊、每个群各有自己的 workspace、下载目录和会话记录目录；
 *   - 工具范围：私聊为完整工具；群按 toolPolicy（full / restricted=只读 / none）；
 *   - 系统提示：账户 systemPrompt、群名、群行为提示；
 *   - 问答界面：把 mu 的审批 / 选择问题发到 QQ（按钮 + 序号），只接受 allowFrom 中的人作答。
 */
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AnswerOutcome, ChatSurface, ChatUIBridge } from "../host/chat-ui.ts";
import type { ChannelLogger } from "../host/logger.ts";
import { safeSegment } from "../host/paths.ts";
import {
	type ChannelSession,
	type ChannelTurn,
	openChannelSession,
	runChannelTurn,
	type ToolAccess,
} from "../host/session.ts";
import { type Lease, SessionPool, SessionPoolFullError } from "../host/session-pool.ts";
import { resolveGroupConfigFromAccount } from "./config.ts";
import type { MuPermissionMode, ResolvedQQBotAccount } from "./types.ts";

export interface ConversationRef {
	accountId: string;
	scope: "c2c" | "group";
	/** 私聊为用户 openid，群为群 openid */
	peerId: string;
}

export function conversationKey(ref: ConversationRef): string {
	return `${ref.accountId}:${ref.scope}:${ref.peerId}`;
}

export function conversationTarget(ref: ConversationRef): string {
	return `qqbot:${ref.scope}:${ref.peerId}`;
}

export interface ConversationDirs {
	workspace: string;
	media: string;
	sessions: string;
}

/** 每个会话独立的目录：<root>/<账户>/<c2c|group>/<openid> */
export function conversationDirs(home: string, workspaceRoot: string, ref: ConversationRef): ConversationDirs {
	const parts = [safeSegment(ref.accountId), ref.scope, safeSegment(ref.peerId)];
	return {
		workspace: join(workspaceRoot, ...parts),
		media: join(home, "media", ...parts),
		sessions: join(home, "sessions", ...parts),
	};
}

/** 群 toolPolicy → mu 工具范围。偏离原行为：原版 restricted 在 OpenClaw 中实际不限制（空 allow 列表 = 全部允许）。 */
export function toolAccessFor(account: ResolvedQQBotAccount, ref: ConversationRef): ToolAccess {
	if (ref.scope !== "group") return "full";
	const policy = resolveGroupConfigFromAccount(account, ref.peerId).toolPolicy;
	return policy === "full" ? "full" : policy === "none" ? "none" : "readonly";
}

/** restricted（只读）群里仍可用的 QQ 工具：它们只发消息，不改动主机 */
export const READONLY_QQBOT_TOOLS = ["qqbot_send_media", "qqbot_remind"] as const;

/** 明确列在 allowFrom 中（不含 "*"）的用户：运维者。可以执行 mu 的斜杠命令（Q5a）、回答审批、让工具越出会话目录 */
export function isExplicitAdmin(account: ResolvedQQBotAccount, senderId: string | undefined): boolean {
	if (!senderId) return false;
	return (account.config?.allowFrom ?? []).map((id) => String(id)).includes(senderId);
}

/**
 * 审批授权。mu 修正：原版 isApprovalAuthorized 在 allowFrom 为空或含 "*" 时允许所有人作答，
 * 在 mu 中这等于让发起请求的人批准自己的命令；现在只有明确列在 allowFrom 中的人能作答。
 */
export function isOperatorAuthorized(account: ResolvedQQBotAccount, operatorId: string | undefined): boolean {
	return isExplicitAdmin(account, operatorId);
}

/** 每个会话的系统提示补充：通道说明 + 账户 systemPrompt + 群名 + 群行为提示（Q6b） */
export function buildChannelPrompt(account: ResolvedQQBotAccount, ref: ConversationRef): string {
	const lines = [
		ref.scope === "group"
			? "你正在通过 QQ 机器人在 QQ 群聊中回复消息。群消息以「[昵称 (openid)] 内容」的形式给出，被 @ 时带 (@you)。"
			: "你正在通过 QQ 机器人在 QQ 私聊中回复消息。",
		"你的回复会以 QQ Markdown 发送给对方。要发送图片、语音、视频或文件，调用 qqbot_send_media 工具。",
	];
	const systemPrompt = account.systemPrompt?.trim();
	if (systemPrompt) lines.push(systemPrompt);
	if (ref.scope === "group") {
		const group = resolveGroupConfigFromAccount(account, ref.peerId);
		if (group.name) lines.push(`当前群: ${group.name}`);
		if (group.prompt?.trim()) lines.push(group.prompt.trim());
	}
	return lines.join("\n");
}

export interface QQBotHostOptions {
	/** ~/.mu/qqbot */
	home: string;
	agentDir: string;
	extensionPaths: readonly string[];
	skillPaths: readonly string[];
	log: ChannelLogger;
	/** 当前账户配置（每次打开会话时读取，热更新后生效） */
	getAccount(accountId: string): ResolvedQQBotAccount;
	/** 本会话的 QQ 工具 */
	createTools(ref: ConversationRef): ToolDefinition[];
	/** 把 mu 的问题发到 QQ */
	createSurface(ref: ConversationRef): ChatSurface;
	/** 默认工作目录根 */
	defaultWorkspaceRoot: string;
}

export type HostTurn = Omit<ChannelTurn, "log"> & {
	/** 本轮消息的发送者（合并批次为全部发送者） */
	senders: readonly string[];
};

interface ActiveTurn {
	abort: AbortController;
	senders: readonly string[];
	trusted: boolean;
}

export class QQBotHost {
	private readonly options: QQBotHostOptions;
	private readonly pools = new Map<string, SessionPool<ChannelSession>>();
	/** 每个会话的回合链：同一会话的回合依次执行（mu 修正：SDK 的合并锁在合并批次执行期间已释放） */
	private readonly chains = new Map<string, Promise<void>>();
	/** 每个会话排队中与进行中的回合 */
	private readonly turns = new Map<string, Set<ActiveTurn>>();
	/** 每个会话当前执行中的回合（工具守卫与提醒工具据此判断是否可信） */
	private readonly current = new Map<string, ActiveTurn>();

	constructor(options: QQBotHostOptions) {
		this.options = options;
	}

	dirsFor(ref: ConversationRef): ConversationDirs {
		const account = this.options.getAccount(ref.accountId);
		return conversationDirs(this.options.home, account.config.workspace || this.options.defaultWorkspaceRoot, ref);
	}

	private poolFor(accountId: string): SessionPool<ChannelSession> {
		let pool = this.pools.get(accountId);
		if (!pool) {
			const sessions = this.options.getAccount(accountId).config.sessions;
			const log = this.options.log.child(`sessions:${accountId}`);
			pool = new SessionPool<ChannelSession>({
				idleMs: (sessions?.idleMinutes ?? 30) * 60_000,
				maxSessions: sessions?.maxSessions ?? 32,
				log,
				create: (key) => this.open(key),
				dispose: (value) => value.dispose(),
				// 有问题在等人回答时不关闭，否则回答就丢了
				canClose: (value) => !value.ui.hasPending && !value.session.isStreaming,
			});
			pool.start();
			this.pools.set(accountId, pool);
		}
		return pool;
	}

	private async open(key: string): Promise<ChannelSession> {
		const [accountId, scope, ...rest] = key.split(":");
		const ref: ConversationRef = { accountId, scope: scope as ConversationRef["scope"], peerId: rest.join(":") };
		const account = this.options.getAccount(accountId);
		const dirs = this.dirsFor(ref);
		const toolAccess = toolAccessFor(account, ref);
		const log = this.options.log.child(`session:${scope}:${ref.peerId.slice(0, 8)}`);
		log.info(`opening session (cwd=${dirs.workspace})`);
		return openChannelSession({
			cwd: dirs.workspace,
			sessionDir: dirs.sessions,
			agentDir: this.options.agentDir,
			extensionPaths: this.options.extensionPaths,
			skillPaths: this.options.skillPaths,
			toolAccess,
			customTools: this.options.createTools(ref),
			readonlyCustomTools: READONLY_QQBOT_TOOLS,
			model: account.config.model,
			permissionMode: account.config.permissions ?? "jev",
			systemPrompt: () => buildChannelPrompt(this.options.getAccount(accountId), ref),
			surface: this.options.createSurface(ref),
			authorize: (operatorId) => isOperatorAuthorized(this.options.getAccount(accountId), operatorId),
			// 私聊里只有对方一人：对方不是运维者时，没人能回答问题，直接取默认（拒绝）而不是等到超时
			answerable: () => this.operatorPresent(ref),
			// mu 修正：会话目录原先只是 cwd。非运维者的回合、以及只读群的所有回合，文件工具只能访问本会话的目录；
			// 其他工具（bash 等）在非运维者的回合里需要运维者在群里点允许，私聊里直接拒绝。
			guard: {
				roots: [dirs.workspace, dirs.media],
				freeTools: [...READONLY_QQBOT_TOOLS],
				confine: () => toolAccess === "readonly" || !this.turnTrusted(ref),
				trusted: () => this.turnTrusted(ref),
				operatorPresent: () => this.operatorPresent(ref),
			},
			uiTimeoutMs: (account.config.approvalTimeoutSeconds ?? 600) * 1000,
			log,
		});
	}

	/** 当前回合是否来自运维者（allowFrom 中明确列出的人；合并批次须全部是） */
	turnTrusted(ref: ConversationRef): boolean {
		return this.current.get(conversationKey(ref))?.trusted ?? false;
	}

	/** 运维者能否在这个会话里看到并回答问题：群里可能在场；私聊只有对方本人 */
	private operatorPresent(ref: ConversationRef): boolean {
		return ref.scope === "group" || isExplicitAdmin(this.options.getAccount(ref.accountId), ref.peerId);
	}

	/**
	 * 在会话里跑一轮。会话数已达上限且全部在用时抛 SessionPoolFullError（调用方提示用户稍后再试）。
	 */
	async runTurn(ref: ConversationRef, turn: HostTurn): Promise<void> {
		const key = conversationKey(ref);
		const account = this.options.getAccount(ref.accountId);
		const active: ActiveTurn = {
			abort: new AbortController(),
			senders: turn.senders,
			trusted: turn.senders.length > 0 && turn.senders.every((id) => isExplicitAdmin(account, id)),
		};
		const signal = turn.signal ? AbortSignal.any([turn.signal, active.abort.signal]) : active.abort.signal;
		const queued = this.turns.get(key) ?? new Set<ActiveTurn>();
		this.turns.set(key, queued);
		queued.add(active);
		const previous = this.chains.get(key) ?? Promise.resolve();
		let done!: () => void;
		const mine = new Promise<void>((resolve) => {
			done = resolve;
		});
		const chain = previous.then(() => mine);
		this.chains.set(key, chain);
		try {
			await previous;
			if (signal.aborted) return;
			let lease: Lease<ChannelSession>;
			try {
				lease = await this.poolFor(ref.accountId).acquire(key);
			} catch (error) {
				if (error instanceof SessionPoolFullError) throw error;
				throw new Error(`无法打开会话: ${error instanceof Error ? error.message : String(error)}`);
			}
			this.current.set(key, active);
			try {
				await runChannelTurn(lease.value.session, { ...turn, signal, log: this.options.log.child("turn") });
				// 被中止的回合要等 pi 真正停下，下一回合才开始
				if (lease.value.session.isStreaming) await lease.value.session.abort();
			} finally {
				this.current.delete(key);
				lease.release();
			}
		} finally {
			queued.delete(active);
			if (queued.size === 0) this.turns.delete(key);
			done();
			if (this.chains.get(key) === chain) this.chains.delete(key);
		}
	}

	/** /stop：中止进行中和排队中的回合，并给等待中的问题默认答案 */
	async abort(ref: ConversationRef): Promise<boolean> {
		const key = conversationKey(ref);
		const queued = [...(this.turns.get(key) ?? [])];
		for (const turn of queued) turn.abort.abort(new Error("stopped"));
		const open = this.pools.get(ref.accountId)?.peek(key);
		const wasBusy = queued.length > 0 || Boolean(open && (open.session.isStreaming || open.ui.hasPending));
		if (open) {
			open.ui.cancelAll();
			if (open.session.isStreaming) await open.session.abort();
		}
		return wasBusy;
	}

	/** 谁能 /stop：私聊的对方；群里的运维者，或正在进行 / 排队的回合的发送者 */
	canStop(ref: ConversationRef, senderId: string | undefined): boolean {
		if (!senderId) return false;
		if (ref.scope === "c2c") return true;
		if (isExplicitAdmin(this.options.getAccount(ref.accountId), senderId)) return true;
		return [...(this.turns.get(conversationKey(ref)) ?? [])].some((turn) => turn.senders.includes(senderId));
	}

	bridge(ref: ConversationRef): ChatUIBridge | undefined {
		return this.pools.get(ref.accountId)?.peek(conversationKey(ref))?.ui;
	}

	/** 按钮点击 */
	answer(ref: ConversationRef, promptId: string, index: number, operatorId: string | undefined): AnswerOutcome {
		return this.bridge(ref)?.answer(promptId, index, operatorId) ?? "unknown";
	}

	/** 有问题等待回答时，一条文字消息是否是回答 */
	answerText(ref: ConversationRef, text: string, senderId: string | undefined): AnswerOutcome {
		return this.bridge(ref)?.answerText(text, senderId) ?? "unknown";
	}

	/**
	 * /bot-approve：已打开的会话立即切换权限模式（新会话从配置读取）。
	 * mu 修正：原先跳过正在回复的会话；pi 在回复中途也立即执行扩展命令，所以忙碌的会话同样切换。
	 */
	async applyPermissionMode(accountId: string, mode: MuPermissionMode): Promise<void> {
		const pool = this.pools.get(accountId);
		if (!pool) return;
		for (const key of pool.keys()) {
			const open = pool.peek(key);
			if (!open?.session.extensionRunner.getCommand("permissions")) continue;
			await open.session.prompt(`/permissions ${mode} --here`, { source: "extension" });
		}
	}

	/**
	 * 配置热更新后：权限模式变了的会话立即切换；工具范围或模型变了的会话在空闲时关闭，下一条消息按新配置重开。
	 * （mu 修正：原先已打开的会话一直保留旧的 toolPolicy / permissions / model，直到闲置回收）
	 */
	async refreshAccount(accountId: string, previous: ResolvedQQBotAccount): Promise<void> {
		const pool = this.pools.get(accountId);
		if (!pool) return;
		const account = this.options.getAccount(accountId);
		const mode = account.config.permissions ?? "jev";
		const modeChanged = mode !== (previous.config.permissions ?? "jev");
		for (const key of pool.keys()) {
			const open = pool.peek(key);
			if (!open) continue;
			const [, scope, ...rest] = key.split(":");
			const ref: ConversationRef = { accountId, scope: scope as ConversationRef["scope"], peerId: rest.join(":") };
			if (toolAccessFor(account, ref) !== open.profile.toolAccess || account.config.model !== open.profile.model) {
				await pool.retire(key);
			} else if (modeChanged && open.session.extensionRunner.getCommand("permissions")) {
				await open.session.prompt(`/permissions ${mode} --here`, { source: "extension" });
			}
		}
	}

	/** 当前打开的会话数（诊断用） */
	openSessions(accountId?: string): number {
		if (accountId) return this.pools.get(accountId)?.size ?? 0;
		let total = 0;
		for (const pool of this.pools.values()) total += pool.size;
		return total;
	}

	async closeAccount(accountId: string): Promise<void> {
		await this.pools.get(accountId)?.closeAll();
		this.pools.delete(accountId);
	}

	async closeAll(): Promise<void> {
		for (const accountId of [...this.pools.keys()]) await this.closeAccount(accountId);
	}
}

export { SessionPoolFullError };
