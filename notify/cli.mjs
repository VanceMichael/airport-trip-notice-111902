#!/usr/bin/env node
// 接驳客服通知工具
// 用法：
//   node notify/cli.mjs collect [--origin http://127.0.0.1:3100] [--request requests/example.json] [--store notify/data/store.json]
//   node notify/cli.mjs list [--store ...]
//   node notify/cli.mjs claim   <通知号> --agent <客服工号>
//   node notify/cli.mjs confirm <通知号> --agent <客服工号>
//   node notify/cli.mjs reset

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { collectSources } from './lib/sources.mjs';
import { assess } from './lib/assess.mjs';
import { reconcile, claim, confirm } from './lib/reconcile.mjs';
import { loadStore, saveStore } from './lib/store.mjs';
import { renderChanges, renderStore } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORE = resolve(HERE, 'data', 'store.json');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      args[token.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const storePath = args.store ? resolve(args.store) : DEFAULT_STORE;

  if (command === 'collect') {
    const origin = args.origin ?? 'http://127.0.0.1:3100';
    const requestPath = resolve(args.request ?? 'requests/example.json');
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    const collected = await collectSources(origin);
    const assessment = assess(request, collected.snapshot);
    const store = await loadStore(storePath);
    const run = {
      id: `run-${store.runs.length + 1}`,
      at: collected.at,
      phase: collected.phase,
      sources: collected.sources,
    };
    const changes = reconcile(store, assessment, run);
    await saveStore(storePath, store);
    console.log(renderChanges(store, changes, run));
    return;
  }

  if (command === 'list') {
    const store = await loadStore(storePath);
    console.log(renderStore(store));
    return;
  }

  if (command === 'claim' || command === 'confirm') {
    const id = args._[1];
    const agent = args.agent;
    if (!id || !agent) throw new Error(`${command} 需要 <通知号> 与 --agent <客服工号>`);
    const store = await loadStore(storePath);
    const at = new Date().toISOString();
    const notice = command === 'claim' ? claim(store, id, agent, at) : confirm(store, id, agent, at);
    await saveStore(storePath, store);
    console.log(`${command === 'claim' ? '已领走' : '已确认'} ${notice.id}｜经办 ${agent}｜${notice.summary}`);
    return;
  }

  if (command === 'reset') {
    const { createStore } = await import('./lib/reconcile.mjs');
    await saveStore(storePath, createStore());
    console.log(`台账已清空：${storePath}`);
    return;
  }

  console.log('用法：collect | list | claim <通知号> --agent <工号> | confirm <通知号> --agent <工号> | reset');
  process.exitCode = command ? 1 : 0;
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
