import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RpcHost } from '../main/rpc-host.mjs';

test('RPC matches replies by id and streams events independently', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const events = [];
  const commands = [];
  child.stdin.on('data', (data) => commands.push(JSON.parse(data.toString())));
  const host = new RpcHost({
    launcher: 'fixture',
    cwd: '/tmp',
    onEvent: (event) => events.push(event),
    spawnProcess: () => child,
  });
  const first = host.send({ type: 'get_state' });
  const second = host.send({ type: 'get_available_models' });
  child.stdout.write(
    JSON.stringify({ type: 'response', id: commands[1].id, success: true, data: { models: [] } }) + '\n'
  );
  child.stdout.write('not json\n' + JSON.stringify({ type: 'agent_start' }) + '\n');
  child.stdout.write(
    JSON.stringify({ type: 'response', id: commands[0].id, success: true, data: { sessionFile: 'fixture' } }) + '\n'
  );
  assert.deepEqual(await first, { sessionFile: 'fixture' });
  assert.deepEqual(await second, { models: [] });
  assert.equal(
    events.some((event) => event.type === 'agent_start'),
    true
  );
  const pending = host.send({ type: 'abort' });
  child.emit('exit', 1, null);
  await assert.rejects(pending, /进程结束/);
  child.stdout.end();
  child.stdin.end();
  child.stderr.end();
});
