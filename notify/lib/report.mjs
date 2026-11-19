// 通知清单文本输出：按行程给出当前该怎样联络，并说明上一条为什么失效。

import { CATEGORY } from './assess.mjs';

const STATUS_LABEL = { open: '待办', claimed: '已领走', confirmed: '已确认', superseded: '已失效' };

function categoryLabel(notice) {
  return CATEGORY[notice.category] ?? notice.category;
}

function sourceText(notice) {
  const sources = (notice.provenance?.sources ?? []).map((s) => `${s.path}#${s.digest}`).join(' ');
  return `阶段 ${notice.provenance?.phase ?? '?'}｜采集 ${notice.provenance?.collectedAt ?? '?'}｜来源 ${sources}`;
}

function timeBasisText(notice) {
  const t = notice.timeBasis;
  if (!t) return '无时刻口径';
  if (t.utc) {
    const cutoff = t.cutoff ? `｜切换口径 ${t.cutoff}` : '';
    return `${t.kindLabel} ${t.utc}（当地 ${t.local}，${t.tz}）${cutoff}`;
  }
  const legs = [t.inbound, t.outbound].filter(Boolean)
    .map((x) => `${x.kindLabel} ${x.utc}（当地 ${x.local}）`).join('；');
  return legs || '无时刻口径';
}

function handlingText(notice) {
  const parts = [];
  if (notice.claimedBy) parts.push(`${notice.claimedBy} 领走于 ${notice.claimedAt}`);
  if (notice.confirmedBy) parts.push(`${notice.confirmedBy} 确认于 ${notice.confirmedAt}`);
  return parts.length ? parts.join('；') : '尚未经办';
}

function line(notice) {
  return `  ${notice.id} [${categoryLabel(notice)}｜${STATUS_LABEL[notice.status]}] ${notice.summary}`;
}

function groupByTrip(notices) {
  const map = new Map();
  for (const notice of notices) {
    if (!map.has(notice.tripId)) map.set(notice.tripId, []);
    map.get(notice.tripId).push(notice);
  }
  return map;
}

function printTripSection(lines, tripId, notices, verbose) {
  const persons = [...new Set(notices.flatMap((n) => n.persons ?? []))].join('、');
  lines.push(`行程 ${tripId}｜旅客 ${persons}`);
  for (const notice of notices) {
    lines.push(line(notice));
    if (verbose) {
      lines.push(`    时间口径：${timeBasisText(notice)}`);
      lines.push(`    来源：${sourceText(notice)}`);
      lines.push(`    经办：${handlingText(notice)}`);
    }
  }
}

// 全量台账视图
export function renderStore(store, { verbose = true } = {}) {
  const lines = [];
  const active = store.notices.filter((n) => n.status === 'open' || n.status === 'claimed');
  const confirmed = store.notices.filter((n) => n.status === 'confirmed');
  const superseded = store.notices.filter((n) => n.status === 'superseded');

  lines.push('== 待办通知（按行程） ==');
  if (active.length === 0) lines.push('（无）');
  for (const [tripId, notices] of groupByTrip(active)) printTripSection(lines, tripId, notices, verbose);

  if (confirmed.length) {
    lines.push('', '== 已确认（口径仍有效，可追溯） ==');
    for (const [tripId, notices] of groupByTrip(confirmed)) printTripSection(lines, tripId, notices, verbose);
  }

  if (superseded.length) {
    lines.push('', '== 已失效（含失效原因） ==');
    for (const notice of superseded) {
      lines.push(line(notice));
      lines.push(`    失效原因：${notice.supersededReason}${notice.supersededBy ? `（由 ${notice.supersededBy} 接替）` : ''}`);
      lines.push(`    失效前经办：${handlingText(notice)}｜失效于 ${notice.supersededAt}`);
      if (verbose) {
        lines.push(`    当时时间口径：${timeBasisText(notice)}`);
        lines.push(`    当时来源：${sourceText(notice)}`);
      }
    }
  }
  return lines.join('\n');
}

// 本轮采集后的变更视图
export function renderChanges(store, changes, run) {
  const lines = [];
  lines.push(`采集完成：阶段 ${run.phase ?? '?'}｜${run.at}`);
  lines.push(`新建 ${changes.created.length} 条，保留 ${changes.kept.length} 条，失效 ${changes.superseded.length} 条`);
  if (changes.superseded.length) {
    lines.push('', '-- 本轮失效 --');
    for (const { notice, reason } of changes.superseded) {
      lines.push(`  ✕ ${notice.id} [${categoryLabel(notice)}] ${notice.summary}`);
      lines.push(`    失效原因：${reason}${notice.supersededBy ? `（由 ${notice.supersededBy} 接替）` : ''}`);
      lines.push(`    失效前经办：${handlingText(notice)}`);
    }
  }
  if (changes.created.length) {
    lines.push('', '-- 本轮新建 --');
    for (const notice of changes.created) {
      lines.push(`  ＋ ${notice.id} [${categoryLabel(notice)}] ${notice.summary}`);
      if (notice.replaces) lines.push(`    （接替 ${notice.replaces}）`);
    }
  }
  lines.push('', renderStore(store));
  return lines.join('\n');
}
