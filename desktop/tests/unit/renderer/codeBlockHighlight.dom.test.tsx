import { render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each highlighting the code block asks for: the language it passes and the code.
const highlighted = vi.hoisted(() => [] as { language: string; code: string; wrapLines?: boolean }[]);

vi.mock('react-syntax-highlighter', () => {
  const Highlighter = ({
    children,
    language,
    wrapLines,
  }: {
    children: string;
    language: string;
    wrapLines?: boolean;
  }) => {
    highlighted.push({ language, code: children, wrapLines });
    return <div data-testid='highlighted'>{children}</div>;
  };
  return { default: Object.assign(Highlighter, { supportedLanguages: ['typescript', 'diff', 'json', 'plaintext'] }) };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@arco-design/web-react', () => ({
  Message: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/renderer/utils/ui/clipboard', () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@icon-park/react', () => ({
  Copy: () => <span />,
  Down: () => <span />,
  Up: () => <span />,
}));

import CodeBlock from '@/renderer/components/Markdown/CodeBlock';

const code = 'export const a = 1;\nexport const b = 2;\n';

describe('a code block while its reply streams', () => {
  beforeEach(() => {
    highlighted.length = 0;
  });

  it('highlights a `ts` block as TypeScript, and its header keeps the label as written', () => {
    render(<CodeBlock className='language-ts'>{code}</CodeBlock>);
    expect(highlighted.map((call) => call.language)).toEqual(['typescript']);
    expect(screen.getByText('ts')).toBeTruthy();
  });

  it('shows a label highlight.js does not know as plain text, and leaves a `:path` after the label out', () => {
    render(<CodeBlock className='language-env'>{code}</CodeBlock>);
    render(<CodeBlock className='language-ts:src/a.ts'>{code}</CodeBlock>);
    expect(highlighted.map((call) => call.language)).toEqual(['text', 'typescript']);
  });

  it('gives a `patch` block the line colours of a diff', () => {
    render(<CodeBlock className='language-patch'>{'+added\n-removed\n'}</CodeBlock>);
    expect(highlighted).toMatchObject([{ language: 'diff', wrapLines: true }]);
  });

  it('does not highlight a block again while its text stays the same', () => {
    // react-markdown hands the block a new syntax node on every chunk of the reply.
    const { rerender } = render(
      <CodeBlock className='language-ts' node={{ chunk: 1 }}>
        {code}
      </CodeBlock>
    );
    rerender(
      <CodeBlock className='language-ts' node={{ chunk: 2 }}>
        {code}
      </CodeBlock>
    );
    expect(highlighted).toHaveLength(1);
    rerender(
      <CodeBlock className='language-ts' node={{ chunk: 3 }}>
        {`${code}export const c = 3;\n`}
      </CodeBlock>
    );
    expect(highlighted).toHaveLength(2);
    expect(highlighted[1].code).toContain('export const c = 3;');
  });
});
