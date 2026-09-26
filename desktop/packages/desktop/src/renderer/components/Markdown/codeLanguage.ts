import SyntaxHighlighter from 'react-syntax-highlighter';

/**
 * highlight.js's aliases, as its 10.7.3 (the grammars of react-syntax-highlighter's default build) resolves them: each
 * registered language with the other names a fence may call it by. Where two languages claim an alias (`h`, `cc`,
 * `hbs`, `ls`, `ml`), it goes to the one highlight.js picks.
 */
const ALIASES_BY_LANGUAGE: Record<string, string> = {
  actionscript: 'as',
  angelscript: 'asc',
  apache: 'apacheconf',
  applescript: 'osascript',
  arduino: 'ino',
  armasm: 'arm',
  asciidoc: 'adoc',
  autohotkey: 'ahk',
  axapta: 'x++',
  bash: 'sh zsh',
  brainfuck: 'bf',
  c: 'h',
  capnproto: 'capnp',
  clean: 'dcl icl',
  clojure: 'clj',
  cmake: 'cmake.in',
  coffeescript: 'coffee cson iced',
  cos: 'cls',
  cpp: 'c++ cc cxx h++ hh hpp hxx',
  crmsh: 'crm pcmk',
  crystal: 'cr',
  csharp: 'c# cs',
  delphi: 'dfm dpr freepascal lazarus lfm lpr pas pascal',
  diff: 'patch',
  django: 'jinja',
  dns: 'bind zone',
  dockerfile: 'docker',
  dos: 'bat cmd',
  dust: 'dst',
  erlang: 'erl',
  excel: 'xls xlsx',
  fortran: 'f90 f95',
  fsharp: 'fs',
  gams: 'gms',
  gauss: 'gss',
  gcode: 'nc',
  gherkin: 'feature',
  go: 'golang',
  haskell: 'hs',
  haxe: 'hx',
  htmlbars: 'hbs html.handlebars html.hbs',
  http: 'https',
  hy: 'hylang',
  inform7: 'i7',
  ini: 'toml',
  java: 'jsp',
  javascript: 'cjs js jsx mjs',
  'jboss-cli': 'wildfly-cli',
  kotlin: 'kt kts',
  lasso: 'lassoscript',
  latex: 'tex',
  livescript: 'ls',
  makefile: 'mak make mk',
  markdown: 'md mkd mkdown',
  mathematica: 'mma wl',
  mercury: 'm moo',
  mipsasm: 'mips',
  moonscript: 'moon',
  nginx: 'nginxconf',
  nix: 'nixos',
  objectivec: 'mm obj-c obj-c++ objc objective-c++',
  openscad: 'scad',
  perl: 'pl pm',
  pf: 'pf.conf',
  pgsql: 'postgres postgresql',
  php: 'php3 php4 php5 php6 php7 php8',
  plaintext: 'text txt',
  powershell: 'ps ps1',
  puppet: 'pp',
  purebasic: 'pb pbi',
  python: 'gyp ipython py',
  'python-repl': 'pycon',
  q: 'k kdb',
  qml: 'qt',
  reasonml: 're',
  roboconf: 'graph instances',
  routeros: 'mikrotik',
  ruby: 'gemspec irb podspec rb thor',
  rust: 'rs',
  scilab: 'sci',
  shell: 'console',
  smalltalk: 'st',
  sml: 'ml',
  sql_more: 'mysql oracle',
  stan: 'stanfuncs',
  stata: 'ado do',
  step21: 'p21 step stp',
  stylus: 'styl',
  tcl: 'tk',
  twig: 'craftcms',
  typescript: 'ts tsx',
  vbnet: 'vb',
  vbscript: 'vbs',
  verilog: 'sv svh v',
  xl: 'tao',
  xml: 'atom html plist rss svg wsf xhtml xjb xsd xsl',
  xquery: 'xpath xq',
  yaml: 'yml',
  zephir: 'zep',
};

/** Alias → language. A Map, so a label such as `constructor` finds nothing rather than Object's own property. */
export const CODE_LANGUAGE_ALIASES: ReadonlyMap<string, string> = new Map(
  Object.entries(ALIASES_BY_LANGUAGE).flatMap(([language, aliases]) =>
    aliases.split(' ').map((alias): [string, string] => [alias, language])
  )
);

const REGISTERED = new Set(SyntaxHighlighter.supportedLanguages);

/**
 * The language react-syntax-highlighter should highlight a fence label as: a registered name, or 'text' for none.
 *
 * The library highlights with a grammar only when the label is a registered language NAME (`typescript`). An alias
 * (`ts`, `py`, `sh`, `html`) or a label it does not know goes to highlight.js's auto-detection, which runs all of its
 * ~190 grammars over the code, on every render, and colours the block as whatever language scored best. A label
 * highlight.js does not know shows as plain text.
 */
export function codeLanguage(label: string): string {
  const key = label.toLowerCase();
  const language = REGISTERED.has(key) ? key : CODE_LANGUAGE_ALIASES.get(key);
  return !language || language === 'plaintext' ? 'text' : language;
}
