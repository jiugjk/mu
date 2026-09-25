/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** A letter of a script written without spaces between words (Han, kana). */
const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** The edge of a Latin name: a letter or a digit. */
const LATIN = /[\p{Script=Latin}\p{Number}]/u;

/**
 * Join a list of display names in the app language.
 *
 * Hardcoded separators ('、', ', ') are wrong in most languages —
 * `Intl.ListFormat` picks the right one per locale (zh: 顿号+和, fa: Arabic
 * comma, de/fr: "und"/"et"). Pass `i18n.language`; falls back to en-US when the
 * tag is malformed.
 *
 * Chinese joins the last two names with 和, written without spaces: next to a
 * Latin name ("clm-latest和clm-raw") it gets one on that side, as Chinese text
 * puts a space between its own words and Latin ones. Full-width punctuation
 * (、) needs none.
 */
export function formatNameList(names: string[], language?: string | null): string {
  const locale = language && language.trim() ? language : 'en-US';
  let format: Intl.ListFormat;
  try {
    format = new Intl.ListFormat(locale, { type: 'conjunction' });
  } catch {
    format = new Intl.ListFormat('en-US', { type: 'conjunction' });
  }
  const parts = format.formatToParts(names);
  return parts
    .map((part, index) => {
      if (part.type !== 'literal') return part.value;
      const before = parts[index - 1]?.value.slice(-1) ?? '';
      const after = parts[index + 1]?.value[0] ?? '';
      const left = SPACELESS.test(part.value[0] ?? '') && LATIN.test(before) ? ' ' : '';
      const right = SPACELESS.test(part.value.slice(-1)) && LATIN.test(after) ? ' ' : '';
      return `${left}${part.value}${right}`;
    })
    .join('');
}
