import { realpath, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import { createHash } from 'node:crypto';

export async function projectFile(root, input) {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('无效文件路径');
  const base = await realpath(root);
  const path = await realpath(resolve(base, input));
  const rel = relative(base, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('文件超出当前项目');
  if (
    rel.split(/[\\/]/).some((part) => ['.git', 'node_modules', '.ssh'].includes(part)) ||
    /^(\.env($|\.)|auth\.json$|.*\.(pem|key)$)/i.test(basename(path))
  )
    throw new Error('此文件不在代码预览范围内');
  const info = await stat(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('只预览 1 MB 以内的文本文件');
  return path;
}
const digest = (text) => createHash('sha256').update(text).digest('hex');
export async function readProjectFile(root, input) {
  const path = await projectFile(root, input);
  const text = await readFile(path, 'utf8');
  if (text.includes('\0')) throw new Error('该文件不是文本');
  return { path: relative(await realpath(root), path), text, revision: digest(text) };
}
export async function saveProjectFile(root, input, text, revision) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) throw new Error('文件内容过大');
  const path = await projectFile(root, input);
  const current = await readFile(path, 'utf8');
  if (digest(current) !== revision) throw new Error('文件已被 Agent 或其他程序修改，请重新载入后再保存。');
  await writeFile(path, text, 'utf8');
  return { path: relative(await realpath(root), path), text, revision: digest(text) };
}
