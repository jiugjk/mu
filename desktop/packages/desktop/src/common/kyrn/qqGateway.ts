/**
 * The QQ bot gateway as the first-run guide writes it, under `channels.qqbot` in mu.json (the same object
 * `mu qqbot` reads). The secret stays in that file; nothing here reads it back to a window.
 */

export const QQ_DM_POLICIES = ['pairing', 'allowlist', 'open', 'disabled'] as const;
export type QqDmPolicy = (typeof QQ_DM_POLICIES)[number];

export const QQ_GROUP_POLICIES = ['open', 'allowlist', 'disabled'] as const;
export type QqGroupPolicy = (typeof QQ_GROUP_POLICIES)[number];

export const QQ_TRANSPORTS = ['websocket', 'webhook'] as const;
export type QqTransport = (typeof QQ_TRANSPORTS)[number];

export type QqGatewayProblem = 'appId' | 'secret' | 'port' | 'path';

/** What the guide asks for. Anything else in `channels.qqbot` (other accounts, allowlists) is left as it was. */
export type QqGatewayInput = {
  enabled: boolean;
  appId: string;
  clientSecret: string;
  transport: QqTransport;
  webhookPort: number;
  webhookPath: string;
  dmPolicy: QqDmPolicy;
  groupPolicy: QqGroupPolicy;
  markdownSupport: boolean;
  defaultRequireMention: boolean;
};

export function defaultQqGateway(): QqGatewayInput {
  return {
    enabled: false,
    appId: '',
    clientSecret: '',
    transport: 'websocket',
    webhookPort: 8787,
    webhookPath: '/qqbot/webhook',
    dmPolicy: 'pairing',
    groupPolicy: 'open',
    markdownSupport: true,
    defaultRequireMention: true,
  };
}

const oneOf = (values: readonly string[], value: string): boolean => values.includes(value);

/** A transport or a policy the guide does not offer. The field checks never produce this; a forged call might. */
export function qqGatewayShapeOk(input: QqGatewayInput): boolean {
  return (
    oneOf(QQ_TRANSPORTS, input.transport) &&
    oneOf(QQ_DM_POLICIES, input.dmPolicy) &&
    oneOf(QQ_GROUP_POLICIES, input.groupPolicy)
  );
}

/**
 * What is wrong with a gateway the person turned on, or undefined. A gateway left off has nothing to check:
 * the guide does not write it.
 */
export function qqGatewayProblem(input: QqGatewayInput): QqGatewayProblem | undefined {
  if (!input.enabled) return undefined;
  if (!/^\d{4,20}$/.test(input.appId.trim())) return 'appId';
  // The same characters a key in the harness .env may use. A space or a quote would not survive the file.
  if (!/^[A-Za-z0-9_./+=:@-]{8,256}$/.test(input.clientSecret.trim())) return 'secret';
  if (input.transport === 'webhook') {
    if (!Number.isInteger(input.webhookPort) || input.webhookPort < 1 || input.webhookPort > 65535) return 'port';
    if (!/^\/[A-Za-z0-9_./-]{0,80}$/.test(input.webhookPath.trim())) return 'path';
  }
  return undefined;
}

/**
 * `channels.qqbot` with the guide's fields written over `current`. Keys the guide does not ask about (other
 * accounts, an allowlist, a system prompt) stay. An empty secret does not wipe one already in the file.
 */
export function mergeQqGateway(current: Record<string, unknown>, input: QqGatewayInput): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...current,
    enabled: input.enabled,
    transport: input.transport,
    markdownSupport: input.markdownSupport,
    dmPolicy: input.dmPolicy,
    groupPolicy: input.groupPolicy,
    defaultRequireMention: input.defaultRequireMention,
  };
  const appId = input.appId.trim();
  if (appId) next.appId = appId;
  const secret = input.clientSecret.trim();
  if (secret) next.clientSecret = secret;
  if (input.transport === 'webhook') {
    const previous =
      current.webhook !== null && typeof current.webhook === 'object' && !Array.isArray(current.webhook)
        ? { ...(current.webhook as Record<string, unknown>) }
        : {};
    const host = typeof previous.host === 'string' && previous.host.trim() ? previous.host : '127.0.0.1';
    next.webhook = {
      ...previous,
      host,
      port: input.webhookPort,
      path: input.webhookPath.trim() || '/qqbot/webhook',
    };
  }
  return next;
}
