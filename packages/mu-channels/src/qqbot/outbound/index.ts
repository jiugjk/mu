export type { MediaKind, SendResult } from "./outbound-service.ts";
export { OutboundService, sendMedia, sendText, sendVideo, sendVoice } from "./outbound-service.ts";
export { isQQBotTarget, normalizeTarget, parseTarget } from "./target.ts";
