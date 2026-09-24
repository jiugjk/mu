/**
 * 版本号获取工具。
 *
 * mu 适配：原版的插件版本由 tsup 在编译时注入（__PLUGIN_VERSION__），框架版本从 OpenClaw runtime /
 * 环境变量 / 文件系统探测。移植后 QQ 通道随 mu 一起发布，两者都是 mu 的版本，由 `mu qqbot` 启动时设置。
 * 调用方在使用时读取（不要在模块顶层缓存），否则会拿到启动前的 "unknown"。
 */

let _version = "unknown";

/** 设置 mu 版本（setQQBotRuntime 调用） */
export function setPackageVersion(version: string): void {
	if (version) _version = version;
}

/** QQ 通道版本 = mu 版本 */
export function getPackageVersion(): string {
	return _version;
}
