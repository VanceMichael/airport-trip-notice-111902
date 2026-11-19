// 来源采集：从演练来源接口拉取四类资料，记录采集时刻与内容摘要，供溯源。

import { createHash } from 'node:crypto';

const ENDPOINTS = [
  ['bulletin', '/airport/bulletin'],
  ['operations', '/carrier/operations'],
  ['transfer', '/airport/transfer'],
  ['desks', '/airport/desks'],
];

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

async function getJson(origin, path) {
  const response = await fetch(origin + path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} 返回 ${response.status}`);
  return response.json();
}

export async function collectSources(origin) {
  const at = new Date().toISOString();
  const meta = await getJson(origin, '/');
  const entries = await Promise.all(ENDPOINTS.map(async ([key, path]) => [key, path, await getJson(origin, path)]));
  const snapshot = Object.fromEntries(entries.map(([key, , value]) => [key, value]));
  const sources = entries.map(([, path, value]) => ({ path, fetchedAt: at, digest: digest(value) }));
  return { at, phase: meta.phase ?? null, snapshot, sources };
}
