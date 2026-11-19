import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { assess } from '../lib/assess.mjs';

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

const byAspect = (assessment, tripId) =>
  Object.fromEntries(assessment.findings.filter((f) => f.tripId === tripId).map((f) => [f.aspect, f]));

test('阶段 0：已起飞未确认落地机场 -> 待核实，不下发接驳点', () => {
  const { findings, resolutions } = assess(request, snapshotAt(0));
  assert.equal(resolutions.length, 0);
  // 全阶段 0 不应出现任何换集合点（M33 缺承运人确认；Q17 缺新机场接驳）
  assert.ok(findings.every((f) => f.category !== 'change_pickup'));

  const r148 = byAspect({ findings }, 'R-148');
  const pending = r148['leg:M33:2026-11-25:arrive'];
  assert.equal(pending.category, 'pending_verify');
  // 官方过渡保留班次优先于通用迁场规则：预计 HC-O 而非 HC-N
  assert.equal(pending.detail.expected, 'HC-O');
  assert.equal(pending.detail.expectedBasis, 'exception');
  assert.match(pending.summary, /暂不下发接驳点/);

  const r145 = byAspect({ findings }, 'R-145');
  assert.equal(r145['leg:M33:2026-11-25:arrive'].category, 'pending_verify');
  const affected = r145['leg:Q17:2026-11-26:depart'];
  // 承运人已确认 HC-N 但新机场接驳未发布 -> 受影响提醒，且不得拿原机场班车填空
  assert.equal(affected.category, 'affected_pending_shuttle');
  assert.equal(affected.detail.airport, 'HC-N');
  assert.ok(!JSON.stringify(affected).includes('西厅'));
  // 前段未确认 -> 衔接待评估
  assert.equal(r145['conn:M33:2026-11-25:arrive>Q17:2026-11-26:depart'].category, 'pending_verify');
});

test('阶段 1：实绩确认新机场、代码共享并段、衔接不足先改签', () => {
  const { findings, resolutions } = assess(request, snapshotAt(1));

  const r148 = byAspect({ findings }, 'R-148');
  const pickup = r148['leg:M33:2026-11-25:arrive'];
  assert.equal(pickup.category, 'change_pickup');
  assert.equal(pickup.detail.airport, 'HC-N');
  assert.equal(pickup.detail.pickup, '北区 4 柱');
  assert.deepEqual(pickup.detail.window, { day: '2026-11-26', first: '00:20', last: '01:20' });
  // 时间口径：实绩 16:35Z = 当地 2026-11-26 00:35
  assert.equal(pickup.timeBasis.kind, 'actual');
  assert.equal(pickup.timeBasis.local, '2026-11-26T00:35:00+08:00');

  const r145 = byAspect({ findings }, 'R-145');
  // 代码共享：MD807 与 QC201 是同一物理航段 M33，只出一条接驳通知
  const arrive = r145['leg:M33:2026-11-25:arrive'];
  assert.equal(arrive.category, 'change_pickup');
  assert.deepEqual(arrive.leg.marketing, ['MD807', 'QC201']);
  assert.equal(arrive.detail.airport, 'HC-N');

  // 衔接：00:35 到 / 01:00 飞 = 25 分钟 < 32 + 18（重新托运）= 50 -> 人工改签
  const conn = r145['conn:M33:2026-11-25:arrive>Q17:2026-11-26:depart'];
  assert.equal(conn.category, 'manual_rebook');
  assert.equal(conn.detail.intervalMin, 25);
  assert.equal(conn.detail.requiredMin, 50);
  assert.equal(conn.detail.recheckExtra, 18);
  assert.equal(conn.detail.desk.desk, '北厅 6');

  // 后段 Q17 的接驳不具独立可用性 -> 暂不下发（resolution），同票前段接驳仍保留
  assert.ok(!r145['leg:Q17:2026-11-26:depart']);
  const held = resolutions.find((r) => r.aspect === 'leg:Q17:2026-11-26:depart');
  assert.ok(held, '应有后段接驳暂不下发的关闭理由');
  assert.match(held.reason, /先人工改签/);
});

test('营销编号不作身份依据：同一物理航段只产生一条事项', () => {
  const { findings } = assess(
    { trips: [{ id: 'T-1', persons: ['P'], legs: [['MD', 'MD807', '2026-11-25'], ['QC', 'QC201', '2026-11-25']], recheck: false }] },
    snapshotAt(1),
  );
  const legs = findings.filter((f) => f.aspect.startsWith('leg:'));
  assert.equal(legs.length, 1);
  assert.equal(legs[0].aspect, 'leg:M33:2026-11-25:arrive');
});
