import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultQqGateway, mergeQqGateway, qqGatewayProblem, type QqGatewayInput } from '@/common/kyrn/qqGateway';
import { saveQqGateway } from '@process/agent/kyrn/qqGateway';

function filled(patch: Partial<QqGatewayInput> = {}): QqGatewayInput {
  return {
    ...defaultQqGateway(),
    enabled: true,
    appId: '102345678',
    clientSecret: 'secret-key-1',
    ...patch,
  };
}

describe('the QQ gateway the guide writes', () => {
  it('asks for a numeric AppID and a secret without spaces, and only once the gateway is on', () => {
    expect(qqGatewayProblem(defaultQqGateway())).toBeUndefined();
    expect(qqGatewayProblem(filled({ appId: 'not-a-number' }))).toBe('appId');
    expect(qqGatewayProblem(filled({ clientSecret: 'short' }))).toBe('secret');
    expect(qqGatewayProblem(filled({ clientSecret: 'has a space!!' }))).toBe('secret');
    expect(qqGatewayProblem(filled({ transport: 'webhook', webhookPort: 0 }))).toBe('port');
    expect(qqGatewayProblem(filled({ transport: 'webhook', webhookPath: 'qqbot' }))).toBe('path');
    expect(qqGatewayProblem(filled())).toBeUndefined();
  });

  it('writes the gateway over channels.qqbot and leaves the rest of mu.json, including other accounts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mu-qq-'));
    writeFileSync(
      join(dir, 'mu.json'),
      `${JSON.stringify({ tiers: ['laya'], channels: { qqbot: { accounts: { work: { appId: '1' } }, allowFrom: ['abc'] } } }, null, 2)}\n`
    );
    saveQqGateway(dir, filled({ transport: 'webhook', webhookPort: 9000, webhookPath: '/hook' }));
    const saved = JSON.parse(readFileSync(join(dir, 'mu.json'), 'utf8')) as {
      tiers: string[];
      channels: { qqbot: Record<string, unknown> };
    };
    expect(saved.tiers).toEqual(['laya']);
    expect(saved.channels.qqbot).toMatchObject({
      enabled: true,
      appId: '102345678',
      clientSecret: 'secret-key-1',
      transport: 'webhook',
      dmPolicy: 'pairing',
      groupPolicy: 'open',
      markdownSupport: true,
      defaultRequireMention: true,
      allowFrom: ['abc'],
      accounts: { work: { appId: '1' } },
      webhook: { host: '127.0.0.1', port: 9000, path: '/hook' },
    });
  });

  it('does not wipe a secret already in the file when the new one is empty, and refuses a gateway left off', () => {
    expect(mergeQqGateway({ clientSecret: 'already-there' }, filled({ clientSecret: '' })).clientSecret).toBe(
      'already-there'
    );
    const dir = mkdtempSync(join(tmpdir(), 'mu-qq-off-'));
    expect(() => saveQqGateway(dir, defaultQqGateway())).toThrow(/Invalid QQ gateway/);
  });
});
