// 行程评估：把订座段清单与四类来源资料合并成「可办事项」。
// 纯函数，不触网、不读写文件，便于单测。
//
// 关键口径：
// - 物理航段身份 = leg + 始发站服务日 + 起降角色；营销编号只用于定位运营记录，不作身份依据。
// - 同一物理航段返航重开后有多条记录，取 recurrence 最大的当次运行。
// - 机场确定顺序：运营记录实绩/承运人确认 > 公告 exception（过渡保留班次）> 通用迁场规则。
// - 通用规则按当地实际或最可靠当前预计的起降时刻与 cutoff 比较。
// - 已起飞但缺落地机场确认 -> 待核实，不下发接驳点。
// - 班车严格按已确认机场匹配，缺新机场接驳时只发受影响提醒，不拿原机场班车填空。

import { createHash } from 'node:crypto';
import { toLocal, localIso, windowContainsUtc, localToUtc } from './time.mjs';

export const CATEGORY = {
  change_pickup: '换集合点',
  manual_rebook: '人工改签',
  pending_verify: '待核实',
  affected_pending_shuttle: '受影响提醒',
};

const TIME_KIND_LABEL = { actual: '实绩', estimated: '预计', planned: '计划' };
const ROLE_LABEL = { arrive: '落地', depart: '起飞' };

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

function dedupeByJson(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

export function normalizeBulletins(raw) {
  return dedupeByJson(Array.isArray(raw) ? raw : [raw]);
}

// 实绩 > 当前预计 > 计划
function bestTime(rec) {
  for (const kind of ['actual', 'estimated', 'planned']) {
    if (rec[kind]) return { kind, utc: rec[kind] };
  }
  return null;
}

function physicalKey(rec) {
  return `${rec.leg}:${rec.serviceDay}:${rec.role}`;
}

// 订座段 -> 运营记录：按营销编号 + 服务日定位，再按物理身份合并去重。
// 不同航司分别列出的代码共享航段在此并成同一物理航段。
function resolveLegs(trip, operations) {
  const byPhysical = new Map();
  const entryFor = (key) => {
    if (!byPhysical.has(key)) byPhysical.set(key, { key, booked: [], records: [] });
    return byPhysical.get(key);
  };
  for (const [carrier, flight, date] of trip.legs) {
    const matches = operations.filter((rec) =>
      Array.isArray(rec.marketing) && rec.marketing.includes(flight) && rec.serviceDay === date);
    if (matches.length === 0) {
      const entry = entryFor(`unresolved:${flight}:${date}`);
      entry.booked.push({ carrier, flight, date });
      continue;
    }
    const groups = new Map();
    for (const rec of matches) {
      const key = physicalKey(rec);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rec);
    }
    for (const [key, records] of groups) {
      const entry = entryFor(key);
      entry.records.push(...records);
      if (!entry.booked.some((b) => b.flight === flight && b.carrier === carrier)) {
        entry.booked.push({ carrier, flight, date });
      }
    }
  }
  return [...byPhysical.values()].map((entry) => {
    const records = dedupeByJson(entry.records);
    // 返航重开：recurrence 最大者为当次实际运行
    const record = records.length
      ? [...records].sort((a, b) => (a.recurrence ?? 0) - (b.recurrence ?? 0)).at(-1)
      : null;
    const marketing = records.length
      ? [...new Set(records.flatMap((rec) => rec.marketing || []))]
      : entry.booked.map((b) => b.flight);
    return { ...entry, records, record, marketing };
  });
}

function pickBulletin(bulletins, rec) {
  if (rec) {
    const byException = bulletins.find((b) =>
      (b.exception || []).some((e) => e.leg === rec.leg && e.role === rec.role));
    if (byException) return byException;
    if (rec.airport) {
      const byAirport = bulletins.find((b) => b.oldAirport === rec.airport || b.newAirport === rec.airport);
      if (byAirport) return byAirport;
    }
  }
  return bulletins[0] || null;
}

// 机场确定：实绩/承运人确认优先；否则官方过渡保留班次（exception）优先于通用迁场规则。
// 已起飞（in_air）而无承运人确认 -> 不确认，仅给出规则预计。
function resolveAirport(rec, bulletin) {
  if (rec.airport) {
    return { confirmed: true, airport: rec.airport, basis: rec.actual ? 'carrier_actual' : 'carrier' };
  }
  let expected = null;
  let expectedBasis = null;
  if (bulletin) {
    const exception = (bulletin.exception || []).find((e) => e.leg === rec.leg && e.role === rec.role);
    const time = bestTime(rec);
    if (exception) {
      expected = exception.airport;
      expectedBasis = 'exception';
    } else if (time) {
      expected = new Date(time.utc) >= new Date(bulletin.cutoff) ? bulletin.newAirport : bulletin.oldAirport;
      expectedBasis = 'general';
    }
  }
  if (rec.state === 'in_air') return { confirmed: false, expected, expectedBasis };
  if (expected) return { confirmed: true, airport: expected, basis: expectedBasis };
  return { confirmed: false, expected, expectedBasis };
}

function buildLegView(leg, ctx) {
  const rec = leg.record;
  if (!rec) return { ...leg, rec: null, bulletin: null, tz: null, time: null, local: null, airport: null };
  const bulletin = pickBulletin(ctx.bulletins, rec);
  const tz = bulletin?.tz ?? 'UTC';
  const time = bestTime(rec);
  const local = time ? toLocal(time.utc, tz) : null;
  const airport = resolveAirport(rec, bulletin);
  return { ...leg, rec, bulletin, tz, time, local, airport };
}

function marketingLabel(view) {
  return `${view.rec ? view.rec.leg : view.marketing.join('/')}（${view.marketing.join('/')}）`;
}

function timeBasisOf(view) {
  if (!view.time) return null;
  return {
    kind: view.time.kind,
    kindLabel: TIME_KIND_LABEL[view.time.kind],
    utc: view.time.utc,
    local: localIso(view.time.utc, view.tz),
    tz: view.tz,
    cutoff: view.bulletin?.cutoff ?? null,
  };
}

function assessLeg(trip, view, ctx) {
  const base = {
    tripId: trip.id,
    persons: trip.persons,
    aspect: `leg:${view.key}`,
    leg: {
      key: view.key,
      marketing: view.marketing,
      booked: view.booked,
      role: view.rec?.role ?? null,
      state: view.rec?.state ?? null,
      serviceDay: view.rec?.serviceDay ?? view.booked[0]?.date ?? null,
    },
  };
  const rec = view.rec;
  if (!rec) {
    return {
      ...base,
      category: 'pending_verify',
      summary: `待核实：${view.marketing.join('/')} 查无运营记录，需向承运人核实`,
      detail: { problem: 'no_operations' },
      timeBasis: null,
    };
  }
  if (rec.state === 'cancelled') {
    return {
      ...base,
      category: 'manual_rebook',
      summary: `人工改签：${marketingLabel(view)} 已取消，请安排人工改签`,
      detail: { problem: 'cancelled' },
      timeBasis: timeBasisOf(view),
    };
  }
  if (rec.state === 'returned') {
    return {
      ...base,
      category: 'manual_rebook',
      summary: `人工改签：${marketingLabel(view)} 返航且未见重开运行，请安排人工改签`,
      detail: { problem: 'returned_no_recurrence' },
      timeBasis: timeBasisOf(view),
    };
  }
  const roleLabel = ROLE_LABEL[rec.role] ?? rec.role;
  const timeBasis = timeBasisOf(view);
  if (!view.airport.confirmed) {
    const expectedText = view.airport.expected
      ? `；按${view.airport.expectedBasis === 'exception' ? '官方过渡保留班次' : '通用迁场规则'}预计 ${view.airport.expected}`
      : '';
    return {
      ...base,
      category: 'pending_verify',
      summary: `待核实：${marketingLabel(view)} 已起飞，${roleLabel}机场未获承运人确认${expectedText}；暂不下发接驳点`,
      detail: {
        problem: 'landing_unconfirmed',
        state: rec.state,
        expected: view.airport.expected,
        expectedBasis: view.airport.expectedBasis,
      },
      timeBasis,
    };
  }
  const airport = view.airport.airport;
  const bus = (ctx.snapshot.transfer?.bus ?? []).find((b) =>
    b.airport === airport && windowContainsUtc(b.day, b.first, b.last, view.tz, view.time.utc));
  if (bus) {
    return {
      ...base,
      category: 'change_pickup',
      summary: `换集合点：${marketingLabel(view)} ${timeBasis.local} ${roleLabel} ${airport}，` +
        `集合点 ${bus.pickup}，乘车窗口 ${bus.day} ${bus.first}–${bus.last}（当地，末班含该分钟）`,
      detail: {
        problem: null,
        airport,
        airportBasis: view.airport.basis,
        pickup: bus.pickup,
        window: { day: bus.day, first: bus.first, last: bus.last },
      },
      timeBasis,
    };
  }
  return {
    ...base,
    category: 'affected_pending_shuttle',
    summary: `受影响提醒：承运人已确认${roleLabel}机场 ${airport}（${marketingLabel(view)}），` +
      `但该机场接驳信息尚未发布；勿以原机场班车代替`,
    detail: { problem: 'shuttle_missing', airport, airportBasis: view.airport.basis },
    timeBasis,
  };
}

function deskWindowUtc(desk, tz) {
  const from = localToUtc(desk.day, desk.fromTime, tz);
  let through = localToUtc(desk.day, desk.throughTime, tz) + 59999;
  if (through < from) through += 86400000;
  return { from, through };
}

// 联程评估：前段落地 -> 后段起飞。返回事项、衔接正常标记（connection_ok）或 null（资料不足已有前段事项）。
function assessConnection(trip, viewA, viewB, ctx) {
  const aspect = `conn:${viewA.key}>${viewB.key}`;
  const base = { tripId: trip.id, persons: trip.persons, aspect };
  const labelA = viewA.rec ? viewA.rec.leg : viewA.marketing.join('/');
  const labelB = viewB.rec ? viewB.rec.leg : viewB.marketing.join('/');
  if (!viewA.rec || !viewB.rec) {
    return { ...base, category: 'pending_verify', summary: `待核实：${labelA} → ${labelB} 衔接缺少运营记录`, detail: { problem: 'missing_operations' }, timeBasis: null };
  }
  if (!viewA.airport?.confirmed || !viewA.time) {
    return { ...base, category: 'pending_verify', summary: `待核实：前段 ${labelA} 落地机场/时刻未确认，${labelB} 衔接待评估`, detail: { problem: 'inbound_unconfirmed' }, timeBasis: { inbound: timeBasisOf(viewA), outbound: timeBasisOf(viewB) } };
  }
  if (!viewB.airport?.confirmed || !viewB.time) {
    return { ...base, category: 'pending_verify', summary: `待核实：后段 ${labelB} 起飞机场/时刻未确认，衔接待评估`, detail: { problem: 'outbound_unconfirmed' }, timeBasis: { inbound: timeBasisOf(viewA), outbound: timeBasisOf(viewB) } };
  }
  const from = viewA.airport.airport;
  const to = viewB.airport.airport;
  const intervalMin = Math.round((new Date(viewB.time.utc) - new Date(viewA.time.utc)) / 60000);
  const timeBasis = { inbound: timeBasisOf(viewA), outbound: timeBasisOf(viewB) };
  const minimum = (ctx.snapshot.transfer?.minima ?? []).find((m) => m.fromAirport === from && m.toAirport === to);
  if (!minimum) {
    return { ...base, category: 'pending_verify', summary: `待核实：缺少 ${from}→${to} 的最短换乘资料，衔接待评估`, detail: { problem: 'missing_minimum', from, to }, timeBasis };
  }
  const recheckExtra = trip.recheck ? minimum.recheckExtra ?? 0 : 0;
  const requiredMin = minimum.minutes + recheckExtra;
  // 需重新托运时核对柜台交接时段（后段起飞机场、后段订座承运人、后段当地日）
  let desk = null;
  let deskProblem = null;
  if (trip.recheck) {
    const carrier = viewB.booked[0]?.carrier;
    desk = (ctx.snapshot.desks ?? []).find((d) =>
      d.airport === to && d.carrier === carrier && d.day === viewB.local.day) ?? null;
    if (!desk) {
      deskProblem = 'no_desk';
    } else {
      const win = deskWindowUtc(desk, viewB.tz);
      const arr = new Date(viewA.time.utc).getTime();
      const dep = new Date(viewB.time.utc).getTime();
      if (!(arr <= win.through && dep >= win.from)) deskProblem = 'desk_window';
    }
  }
  const detail = {
    from, to,
    arriveLocal: timeBasis.inbound.local,
    departLocal: timeBasis.outbound.local,
    intervalMin,
    requiredMin,
    minimumMin: minimum.minutes,
    recheck: Boolean(trip.recheck),
    recheckExtra,
    desk: desk ? { ...desk } : null,
    deskProblem,
  };
  if (intervalMin < requiredMin || deskProblem) {
    const why = [];
    if (intervalMin < requiredMin) {
      why.push(`衔接 ${intervalMin} 分钟 < 需 ${requiredMin} 分钟（换乘 ${minimum.minutes}${trip.recheck ? ` + 重新托运 ${recheckExtra}` : ''}）`);
    }
    if (deskProblem === 'no_desk') why.push(`${to} 无 ${viewB.booked[0]?.carrier} 可重办托运柜台`);
    if (deskProblem === 'desk_window') why.push(`柜台时段 ${desk.fromTime}–${desk.throughTime} 覆盖不了衔接`);
    return {
      ...base,
      category: 'manual_rebook',
      summary: `人工改签：${labelA} ${detail.arriveLocal} 到 ${from}，${labelB} ${detail.departLocal} ${to} 起飞，${why.join('；')}，请先安排人工改签`,
      detail: { problem: intervalMin < requiredMin ? 'connection_short' : 'desk_unusable', ...detail },
      timeBasis,
    };
  }
  return {
    ...base,
    category: 'connection_ok',
    summary: `衔接可满足：${labelA} → ${labelB} 间隔 ${intervalMin} 分钟 ≥ 需 ${requiredMin} 分钟`,
    detail: { problem: null, ...detail },
    timeBasis,
  };
}

// 评估全部行程，产出可办事项（findings）与既有事项的关闭理由（resolutions）。
export function assess(request, snapshot) {
  const ctx = { bulletins: normalizeBulletins(snapshot.bulletin), snapshot };
  const findings = [];
  const resolutions = [];
  for (const trip of request.trips) {
    const legs = resolveLegs(trip, snapshot.operations ?? []);
    const views = legs.map((leg) => buildLegView(leg, ctx));
    const legFindings = views.map((view) => assessLeg(trip, view, ctx));
    const connections = [];
    for (let i = 0; i + 1 < views.length; i += 1) {
      connections.push({ index: i, result: assessConnection(trip, views[i], views[i + 1], ctx) });
    }
    // 衔接不足需先改签时，后段接驳不具独立可用性，暂不下发；
    // 同份票里其他段的独立可用接驳仍保留。
    const blockedLegs = new Map();
    for (const { index, result } of connections) {
      if (result?.category === 'manual_rebook') {
        blockedLegs.set(index + 1, result.aspect);
        result.detail.blockedLegAspect = `leg:${views[index + 1].key}`;
      }
    }
    views.forEach((view, i) => {
      const finding = legFindings[i];
      if (!finding) return;
      if (blockedLegs.has(i) && (finding.category === 'change_pickup' || finding.category === 'affected_pending_shuttle')) {
        resolutions.push({
          tripId: trip.id,
          aspect: finding.aspect,
          reason: `后段衔接不足需先人工改签（见 ${blockedLegs.get(i)}），本段接驳暂不下发`,
        });
        return;
      }
      findings.push(finalize(finding));
    });
    for (const { result } of connections) {
      if (!result) continue;
      if (result.category === 'connection_ok') {
        resolutions.push({ tripId: trip.id, aspect: result.aspect, reason: result.summary });
      } else {
        findings.push(finalize(result));
      }
    }
  }
  return { findings, resolutions };
}

// 指纹只取可办内容本身：内容变了才换版，来源时间戳不影响。
function finalize(finding) {
  const essence = {
    category: finding.category,
    summary: finding.summary,
    detail: finding.detail,
    timeBasis: finding.timeBasis,
  };
  return { ...finding, fingerprint: hash(essence) };
}
