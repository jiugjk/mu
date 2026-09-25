import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import SyntaxHighlighter from 'react-syntax-highlighter';
import { describe, expect, it } from 'vitest';
import { CODE_LANGUAGE_ALIASES, codeLanguage } from '@renderer/components/Markdown/codeLanguage';

type Hljs = { listLanguages(): string[]; getLanguage(name: string): { aliases?: string[] } | undefined };

// highlight.js as react-syntax-highlighter's default build loads it (through lowlight), so the table is held to it.
const require = createRequire(__filename);
const lowlight = dirname(
  require.resolve('lowlight/package.json', { paths: [dirname(require.resolve('react-syntax-highlighter'))] })
);
const hljs = require(require.resolve('highlight.js', { paths: [lowlight] })) as Hljs;

describe('the language a code fence is highlighted as', () => {
  it('resolves the aliases models write to the grammar they name', () => {
    expect(codeLanguage('ts')).toBe('typescript');
    expect(codeLanguage('tsx')).toBe('typescript');
    expect(codeLanguage('js')).toBe('javascript');
    expect(codeLanguage('py')).toBe('python');
    expect(codeLanguage('sh')).toBe('bash');
    expect(codeLanguage('html')).toBe('xml');
    expect(codeLanguage('yml')).toBe('yaml');
    expect(codeLanguage('c++')).toBe('cpp');
    expect(codeLanguage('C#')).toBe('csharp');
    expect(codeLanguage('TypeScript')).toBe('typescript');
  });

  it('keeps a registered name, and shows a label highlight.js does not know as plain text', () => {
    expect(codeLanguage('typescript')).toBe('typescript');
    expect(codeLanguage('json')).toBe('json');
    expect(codeLanguage('patch')).toBe('diff');
    for (const label of ['text', 'txt', 'plaintext', 'mermaid', 'env', 'jsonc', 'constructor', '__proto__']) {
      expect(codeLanguage(label), label).toBe('text');
    }
  });

  it('matches the highlight.js of the default build, alias for alias', () => {
    const names = hljs.listLanguages();
    const expected: Record<string, string> = {};
    for (const name of names) {
      for (const alias of hljs.getLanguage(name)?.aliases ?? []) {
        if (names.includes(alias)) continue;
        expected[alias] = names.find((other) => hljs.getLanguage(other) === hljs.getLanguage(alias)) ?? '(none)';
      }
    }
    expect(Object.fromEntries(CODE_LANGUAGE_ALIASES)).toEqual(expected);
  });

  it('only resolves to languages the highlighter has registered', () => {
    for (const language of new Set(CODE_LANGUAGE_ALIASES.values())) {
      expect(SyntaxHighlighter.supportedLanguages, language).toContain(language);
    }
  });
});
