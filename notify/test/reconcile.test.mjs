import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assess } from '../lib/assess.mjs';
import { createStore, reconcile, claim, confirm } from '../lib/reconcile.mjs';

const scenario = JSON.parse(await readFile(new URL('../../scenario.json', import.meta.url), 'utf8'));
const request = JSON.parse(await readFile(new URL('../../requests/example.json', import.meta.url), 'utf8'));

function snapshotAt(phase) {
  const steps = (path) => scenario.routes.find((r) => r.path === path).steps[phase];
  return {
    bulletin: steps('/airport/bulletin'),
    operations: steps('/carrier/operations'),
    transfer: steps('/airport/transfer'),
    desks: steps('/airport/desks'),
  };
}

const run = (n, phase) => ({
  id: `run-${n}`,
  at: `2026-11-19T0${n}:00:00.000Z`,
  phase,
  sources: [{ path: '/carrier/operations', fetchedAt: `2026-11-19T0${n}:00:00.000Z`, digest: `d${n}` }],
});

const activeOf = (store) => store.notices.filter((n) => n.status !== 'superseded');

test('跨阶段对账：失效写明原因、可溯源、不重复下发', () => {
  const store = createStore();

  // 阶段 0：4 条待办（R-145 三条 + R-148 一条）
  const first = reconcile(store, assess(request, snapshotAt(0)), run(1, 0));
  assert.equal(first.created.length, 4);
  assert.equal(first.superseded.length, 0);

  const r148Pending = store.notices.find((n) => n.tripId === 'R-148');
  // 客服确认后仍可追溯当时来源与时间口径
  claim(store, r148Pending.id, 'K01', '2026-11-19T01:30:00.000Z');
  confirm(store, r148Pending.id, 'K01', '2026-11-19T01:31:00.000Z');
  assert.equal(r148Pending.status, 'confirmed');
  assert.equal(r148Pending.provenance.phase, 0);
  assert.equal(r148Pending.timeBasis.kind, 'estimated');

  // 阶段 1：实绩落地 HC-N，与先前口径不同 -> 全部更新
  const second = reconcile(store, assess(request, snapshotAt(1)), run(2, 1));
  assert.equal(second.superseded.length, 4);
  assert.equal(second.created.length, 3); // R-148 换集合点；R-145 换集合点 + 人工改签

  const supersededR148 = store.notices.find((n) => n.id === r148Pending.id);
  assert.equal(supersededR148.status, 'superseded');
  assert.match(supersededR148.supersededReason, /HC-N/);
  assert.match(supersededR148.supersededReason, /HC-O/); // 说明原预计口径
  assert.equal(supersededR148.confirmedBy, 'K01'); // 失效前经办保留

  // 新通知接续关系与溯源
  const next = store.notices.find((n) => n.id === supersededR148.supersededBy);
  assert.equal(next.category, 'change_pickup');
  assert.equal(next.replaces, r148Pending.id);
  assert.equal(next.provenance.phase, 1);
  assert.equal(next.timeBasis.kind, 'actual');

  // R-145 后段接驳提醒因「先改签」关闭，且没有替代表决
  const held = store.notices.find((n) => n.aspect === 'leg:Q17:2026-11-26:depart' && n.status === 'superseded');
  assert.match(held.supersededReason, /先人工改签/);

  // 同一行程同一事项只有一条有效通知（代码共享不重复）
  const seen = new Set();
  for (const n of activeOf(store)) {
    const key = `${n.tripId}|${n.aspect}`;
    assert.ok(!seen.has(key), `重复通知 ${key}`);
    seen.add(key);
  }

  // 幂等：同批资料再对账不产生变化
  const third = reconcile(store, assess(request, snapshotAt(1)), run(3, 1));
  assert.equal(third.created.length, 0);
  assert.equal(third.superseded.length, 0);
  assert.equal(third.kept.length, 3);
});

test('已失效通知不能领走或确认', () => {
  const store = createStore();
  reconcile(store, assess(request, snapshotAt(0)), run(1, 0));
  const notice = store.notices[0];
  reconcile(store, assess(request, snapshotAt(1)), run(2, 1));
  assert.equal(notice.status, 'superseded');
  assert.throws(() => claim(store, notice.id, 'K02', '2026-11-19T02:00:00.000Z'), /不能领走/);
  assert.throws(() => confirm(store, notice.id, 'K02', '2026-11-19T02:00:00.000Z'), /已失效/);
});
