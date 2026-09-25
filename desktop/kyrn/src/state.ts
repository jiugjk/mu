export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
export const str = (value: unknown): string => (typeof value === 'string' ? value : '');
export const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const contentText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : list(content)
        .map((block) => (record(block).type === 'text' ? str(record(block).text) : ''))
        .filter(Boolean)
        .join('\n');
export interface Envelope {
  sessionId: string;
  sequence: number;
  at: number;
  event: RecordValue;
}
export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
}
export interface Model {
  id: string;
  provider: string;
  name: string;
}
export interface SessionSnapshot extends SessionMeta {
  events: Envelope[];
  busy: boolean;
  state?: RecordValue;
  models: Model[];
  dialogs: RecordValue[];
}
export interface TimelineItem {
  id: string;
  type: 'user' | 'assistant' | 'tool' | 'verdict' | 'notice';
  text: string;
  data?: RecordValue;
  running?: boolean;
}
export interface ViewState {
  items: TimelineItem[];
  phase: string;
  judge: string;
  decisions: RecordValue[];
  swarm?: RecordValue;
  busy: boolean;
  dialogs: RecordValue[];
}

/** Replay actual runtime events; no simulated progress, confidence, or bee percentages. */
export function foldEvents(events: Envelope[]): ViewState {
  const items: TimelineItem[] = [];
  const decisions: RecordValue[] = [];
  const tools = new Map<string, TimelineItem>();
  const verdicts = new Map<string, TimelineItem>();
  const dialogs = new Map<string, RecordValue>();
  let streaming: TimelineItem | undefined;
  let phase = '就绪';
  let judge = '等待判断';
  let swarm: RecordValue | undefined;
  let busy = false;
  for (const envelope of events) {
    const e = envelope.event;
    const id = String(envelope.sequence);
    if (e.type === 'kyrn_submission') {
      items.push({ id, type: 'user', text: str(e.text) });
      phase = e.behavior ? '消息已进入队列' : '已接收，准备分类';
      busy = true;
    } else if (e.type === 'agent_start') {
      phase = '正在执行';
      busy = true;
    } else if (e.type === 'kyrn_host_ready') {
      phase = '就绪';
      busy = false;
      dialogs.clear();
    } else if (e.type === 'kyrn_state') {
      busy = e.busy === true;
      if (!busy) phase = '就绪';
    } else if (e.type === 'agent_settled') {
      phase = '本轮完成';
      busy = false;
    } else if (e.type === 'message_start' && record(e.message).role === 'assistant') {
      streaming = { id, type: 'assistant', text: '', running: true };
      items.push(streaming);
    } else if (e.type === 'message_update') {
      const delta = record(e.assistantMessageEvent);
      if (delta.type === 'text_delta') {
        if (!streaming) {
          streaming = { id, type: 'assistant', text: '', running: true };
          items.push(streaming);
        }
        streaming.text += str(delta.delta);
      }
    } else if (e.type === 'message_end' && record(e.message).role === 'assistant') {
      const message = record(e.message);
      const text = contentText(message.content);
      if (streaming) {
        streaming.text = text;
        streaming.running = false;
      } else if (text) items.push({ id, type: 'assistant', text });
      streaming = undefined;
      if (message.errorMessage) items.push({ id: id + '-error', type: 'notice', text: str(message.errorMessage) });
    } else if (e.type === 'tool_execution_start') {
      const item: TimelineItem = {
        id,
        type: 'tool',
        text: str(e.toolName),
        data: { args: e.args, toolCallId: e.toolCallId },
        running: true,
      };
      tools.set(str(e.toolCallId), item);
      items.push(item);
      phase = `执行 ${str(e.toolName)}`;
    } else if (e.type === 'tool_execution_update' || e.type === 'tool_execution_end') {
      const result = record(e.partialResult || e.result);
      const item = tools.get(str(e.toolCallId));
      if (item) {
        item.data = { ...item.data, result: contentText(result.content), isError: e.isError };
        item.running = e.type !== 'tool_execution_end';
      }
      const details = record(result.details);
      if (details.snapshot) swarm = record(details.snapshot);
    } else if (e.type === 'extension_ui_request') {
      if (e.method === 'setStatus' && e.statusKey === 'kyrn.presentation.v1') {
        let p: RecordValue;
        try {
          p = record(JSON.parse(str(e.statusText)));
        } catch {
          continue;
        }
        const payload = record(p.payload);
        const key = `${str(p.runtimeId)}:${num(p.turnId)}`;
        if (p.kind === 'preflight.pending') {
          judge = str(payload.judge);
          phase = '正在判断任务类型';
          const item: TimelineItem = { id, type: 'verdict', text: judge, data: { state: 'pending' }, running: true };
          verdicts.set(key, item);
          items.push(item);
        } else if (p.kind === 'preflight.verdict') {
          const item = verdicts.get(key);
          if (item) {
            item.data = payload;
            item.running = false;
          } else items.push({ id, type: 'verdict', text: str(payload.by), data: payload });
          phase = payload.state === 'late' ? phase : '分类完成，准备执行';
        } else if (p.kind === 'preflight.wait_end') {
          const item = verdicts.get(key);
          if (item?.running) {
            item.running = false;
            item.data = { state: 'none', reason: payload.reason, latencyMs: payload.waitedMs };
          }
        } else if (p.kind === 'decision') decisions.push(payload);
        else if (p.kind === 'progress') phase = str(payload.step);
      } else if (e.method === 'notify') items.push({ id, type: 'notice', text: str(e.message) });
      else if (['confirm', 'input', 'select', 'editor'].includes(str(e.method))) dialogs.set(str(e.id), e);
    } else if (e.type === 'kyrn_approval_resolved') dialogs.delete(str(e.id));
    else if (e.type === 'kyrn_error' || e.type === 'kyrn_host_exit') {
      items.push({ id, type: 'notice', text: str(e.message || e.reason) });
      busy = false;
      phase = '需要关注';
      if (e.type === 'kyrn_host_exit') dialogs.clear();
    } else if (e.type === 'auto_retry_start') phase = `请求重试 ${num(e.attempt)}/${num(e.maxAttempts)}`;
  }
  return {
    items: items.filter((item) => item.text || item.type !== 'assistant'),
    phase,
    judge,
    decisions,
    swarm,
    busy,
    dialogs: [...dialogs.values()],
  };
}

declare global {
  interface Window {
    kyrn: {
      request<T = unknown>(method: string, args?: RecordValue): Promise<T>;
      subscribe(listener: (event: Envelope) => void): () => void;
    };
  }
}
