// 通知台账对账：把本轮评估结果与既有通知比对。
// - 内容指纹不变 -> 保留（含已领走/已确认状态与溯源）。
// - 同事项内容变化 -> 旧通知失效并写明原因，生成接替通知。
// - 事项消失 -> 按评估给出的关闭理由失效。
// 失效通知保留在台账中，可追到当时采用的来源与时间口径。

import { CATEGORY } from './assess.mjs';

export function createStore() {
  return { version: 1, nextId: 1, notices: [], runs: [] };
}

const ACTIVE = new Set(['open', 'claimed', 'confirmed']);

function activeByAspect(store) {
  const map = new Map();
  for (const notice of store.notices) {
    if (ACTIVE.has(notice.status)) map.set(`${notice.tripId}|${notice.aspect}`, notice);
  }
  return map;
}

function basisText(timeBasis) {
  if (!timeBasis) return '无时刻口径';
  if (timeBasis.utc) return `${timeBasis.kindLabel} ${timeBasis.local}（${timeBasis.tz}）`;
  const legs = [timeBasis.inbound, timeBasis.outbound].filter(Boolean)
    .map((t) => `${t.kindLabel} ${t.local}`).join(' / ');
  return legs || '无时刻口径';
}

// 旧通知 -> 新事项 的失效原因
function transitionReason(old, next) {
  const o = old.detail ?? {};
  const n = next.detail ?? {};
  const from = CATEGORY[old.category] ?? old.category;
  const to = CATEGORY[next.category] ?? next.category;
  if (old.category === 'pending_verify' && next.category === 'change_pickup') {
    const expected = o.expected
      ? `原按${o.expectedBasis === 'exception' ? '官方过渡保留班次' : '通用迁场规则'}预计 ${o.expected}`
      : '原无机场口径';
    return `机场已获确认（${n.airport}，${basisText(next.timeBasis)}）；${expected}，以最新确认/实绩为准，待核实关闭`;
  }
  if (old.category === 'pending_verify' && next.category === 'manual_rebook') {
    return `机场与时刻已确认，但${n.problem === 'connection_short' ? `衔接仅 ${n.intervalMin} 分钟、不足所需 ${n.requiredMin} 分钟` : '航段状态异常'}，待核实关闭，转为人工改签`;
  }
  if (old.category === 'affected_pending_shuttle' && next.category === 'change_pickup') {
    return `${n.airport} 接驳信息已发布（${n.pickup}，${n.window.day} ${n.window.first}–${n.window.last}），受影响提醒关闭，改发集合点`;
  }
  if (old.category === 'affected_pending_shuttle' && next.category === 'manual_rebook') {
    return '需先人工改签，受影响提醒关闭';
  }
  if (old.category === 'change_pickup' && next.category === 'change_pickup') {
    if (o.airport !== n.airport) {
      return `实绩/最新确认与先前不同：机场由 ${o.airport} 变为 ${n.airport}（${basisText(next.timeBasis)}），集合点相应变更`;
    }
    return `接驳口径更新：集合点 ${o.pickup} → ${n.pickup}，窗口 ${n.window.day} ${n.window.first}–${n.window.last}`;
  }
  if (next.category === 'manual_rebook') {
    return `后续资料要求先人工改签（${next.summary}），原「${from}」失效`;
  }
  if (old.category === next.category) return `同类事项内容更新（${from}），按最新资料重发`;
  return `事项性质由「${from}」变为「${to}」，按最新资料处理`;
}

function supersede(notice, reason, run, byId = null) {
  notice.status = 'superseded';
  notice.supersededAt = run.at;
  notice.supersededReason = reason;
  notice.supersededBy = byId;
  notice.history.push({ at: run.at, event: 'superseded', note: reason, by: byId });
}

export function reconcile(store, assessment, run) {
  const active = activeByAspect(store);
  const changes = { created: [], kept: [], superseded: [] };
  const seen = new Set();

  for (const finding of assessment.findings) {
    const key = `${finding.tripId}|${finding.aspect}`;
    seen.add(key);
    const existing = active.get(key);
    if (existing && existing.fingerprint === finding.fingerprint) {
      existing.lastSeenRun = run.id;
      changes.kept.push(existing);
      continue;
    }
    const notice = {
      id: `N-${String(store.nextId).padStart(4, '0')}`,
      tripId: finding.tripId,
      persons: finding.persons,
      aspect: finding.aspect,
      category: finding.category,
      summary: finding.summary,
      detail: finding.detail,
      timeBasis: finding.timeBasis,
      fingerprint: finding.fingerprint,
      status: 'open',
      createdAt: run.at,
      lastSeenRun: run.id,
      provenance: {
        run: run.id,
        collectedAt: run.at,
        phase: run.phase,
        sources: run.sources,
      },
      history: [{ at: run.at, event: 'created', note: finding.summary }],
    };
    store.nextId += 1;
    if (existing) {
      const reason = transitionReason(existing, finding);
      supersede(existing, reason, run, notice.id);
      notice.history[0].note = `${finding.summary}（接替 ${existing.id}）`;
      notice.replaces = existing.id;
      changes.superseded.push({ notice: existing, reason });
    }
    store.notices.push(notice);
    changes.created.push(notice);
  }

  for (const resolution of assessment.resolutions) {
    const key = `${resolution.tripId}|${resolution.aspect}`;
    seen.add(key);
    const existing = active.get(key);
    if (existing) {
      supersede(existing, resolution.reason, run);
      changes.superseded.push({ notice: existing, reason: resolution.reason });
    }
  }

  for (const [key, notice] of active) {
    if (!seen.has(key)) {
      const reason = '当前资料下该事项已不再适用';
      supersede(notice, reason, run);
      changes.superseded.push({ notice, reason });
    }
  }

  store.runs.push({
    id: run.id,
    at: run.at,
    phase: run.phase,
    sources: run.sources,
    created: changes.created.map((n) => n.id),
    superseded: changes.superseded.map((s) => s.notice.id),
  });
  return changes;
}

export function claim(store, id, agent, at) {
  const notice = store.notices.find((n) => n.id === id);
  if (!notice) throw new Error(`查无通知 ${id}`);
  if (!ACTIVE.has(notice.status) || notice.status === 'confirmed') {
    throw new Error(`通知 ${id} 当前状态为「${notice.status}」，不能领走`);
  }
  notice.status = 'claimed';
  notice.claimedBy = agent;
  notice.claimedAt = at;
  notice.history.push({ at, event: 'claimed', agent });
  return notice;
}

export function confirm(store, id, agent, at) {
  const notice = store.notices.find((n) => n.id === id);
  if (!notice) throw new Error(`查无通知 ${id}`);
  if (!ACTIVE.has(notice.status)) throw new Error(`通知 ${id} 已失效，不能确认`);
  notice.status = 'confirmed';
  notice.confirmedBy = agent;
  notice.confirmedAt = at;
  notice.history.push({ at, event: 'confirmed', agent });
  return notice;
}
