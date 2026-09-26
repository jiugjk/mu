import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The line under a reply that is being worked on ends with one ellipsis in every language: the macOS QA pass read
 * "正在处理中......", two ellipses where one says it.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const localeRoot = join(repoRoot, 'packages/desktop/src/renderer/services/i18n/locales');
const languages = readdirSync(localeRoot).filter((name) => !name.startsWith('.'));

describe('the processing line', () => {
  it('is there in all 13 languages', () => {
    expect(languages).toHaveLength(13);
  });

  it.each(languages)('ends with one ellipsis in %s', (language) => {
    const { chat } = JSON.parse(readFileSync(join(localeRoot, language, 'conversation.json'), 'utf8')) as {
      chat: { processing: string };
    };
    expect(chat.processing).toMatch(/[^.…]…$/);
  });
});
