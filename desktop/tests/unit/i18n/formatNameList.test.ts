import { describe, expect, it } from 'vitest';
import { formatNameList } from '@/renderer/services/i18n/list';

describe('a list of names in the app language', () => {
  it('joins them as each language does', () => {
    expect(formatNameList(['a', 'b', 'c'], 'en-US')).toBe('a, b, and c');
    expect(formatNameList(['a', 'b'], 'de-DE')).toBe('a und b');
    expect(formatNameList(['a', 'b', 'c'], 'ja-JP')).toBe('a、b、c');
    expect(formatNameList(['a', 'b'], 'ko-KR')).toBe('a 및 b');
  });

  it('puts a space between 和 and a Latin name in Chinese, and none next to Chinese or full-width punctuation', () => {
    expect(formatNameList(['clm-latest', 'clm-raw'], 'zh-CN')).toBe('clm-latest 和 clm-raw');
    expect(formatNameList(['clm-latest', 'clm-raw', 'Jev'], 'zh-CN')).toBe('clm-latest、clm-raw 和 Jev');
    expect(formatNameList(['技能', '工具'], 'zh-CN')).toBe('技能和工具');
    expect(formatNameList(['OpenAI', '技能'], 'zh-CN')).toBe('OpenAI 和技能');
    expect(formatNameList(['技能', 'MCP'], 'zh-TW')).toBe('技能和 MCP');
    expect(formatNameList(['GPT-5', 'o3'], 'zh-CN')).toBe('GPT-5 和 o3');
  });

  it('reads a malformed language tag as English, and an empty list as nothing', () => {
    expect(formatNameList(['a', 'b'], 'not a tag')).toBe('a and b');
    expect(formatNameList(['a', 'b'], '')).toBe('a and b');
    expect(formatNameList([], 'zh-CN')).toBe('');
  });
});
