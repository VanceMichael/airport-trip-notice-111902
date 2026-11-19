// 台账持久化：JSON 文件，跨轮次保留通知状态、溯源与历史。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createStore } from './reconcile.mjs';

export async function loadStore(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const store = JSON.parse(raw);
    if (!Array.isArray(store.notices) || !Array.isArray(store.runs)) throw new Error('台账结构不完整');
    return store;
  } catch (error) {
    if (error.code === 'ENOENT') return createStore();
    throw error;
  }
}

export async function saveStore(path, store) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2) + '\n');
}
