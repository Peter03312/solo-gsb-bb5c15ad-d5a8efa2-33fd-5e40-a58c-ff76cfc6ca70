'use strict';

// 访客页：只读最新已发布版本（不可变快照）；亦展示公开专题「先于」脉络路线
//   /            最新年表 + 路线列表
//   /?route=N    仅展示第 N 号路线涉及的事件 / 关系（出处按遮盖规则显示）
const $ = (sel) => document.querySelector(sel);

const PREC_LABEL = { year: '年精度', month: '月精度', day: '日精度' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${y} 年 ${m} 月 ${d} 日`;
}

async function renderRoute(routeNo) {
  let data;
  try {
    const res = await fetch(`/api/public/routes/${encodeURIComponent(routeNo)}`);
    if (res.status === 404) {
      $('#message').innerHTML = '<div class="alert warn">该脉络路线不存在或尚未公开。<br><a href="/">返回年表首页</a></div>';
      return;
    }
    data = await res.json();
  } catch (err) {
    $('#message').innerHTML = `<div class="alert error">路线加载失败：${esc(err.message)}</div>`;
    return;
  }
  const r = data.route;
  $('#versionTag').textContent = `专题路线 #${r.routeNo} · 固定于第 ${r.versionNo} 版`;
  $('#routeViewCard').style.display = '';
  $('#routeViewTitle').textContent = `专题脉络路线 #${r.routeNo}：${r.title}`;
  $('#routeViewMeta').textContent =
    `固定于第 ${r.versionNo} 版不可变快照 · ${r.anchorCount} 个锚点、${r.segments.length} 段见证链，` +
    `涉及 ${r.eventCount} 个事件、${r.relationCount} 条「先于」关系 · 建立于 ${r.createdAt.replace('T', ' ').slice(0, 16)} UTC` +
    (r.editor ? ` · 编辑：${r.editor}` : '');
  $('#routeBackLink').href = '/#routes';

  const titleById = new Map(r.events.map((e) => [e.eventId, e.title]));

  const segHtml = r.segments.map((seg) => {
    const chain = seg.eventIds
      .map((id) => {
        const ev = r.events.find((e) => e.eventId === id);
        const t = titleById.get(id) || `#${id}`;
        const isAnchor = id === seg.fromEventId || id === seg.toEventId;
        const label = isAnchor
          ? `<strong>${esc(t)}</strong>`
          : `<span class="muted">${esc(t)}</span> <span class="badge">中间事件</span>`;
        return `<div class="route-node">${label}<div class="muted" style="font-size:12px">${esc(ev ? ev.resolvedDate : '')}</div></div>`;
      })
      .join('<div class="route-arrow">先于 ↓<div class="muted" style="font-size:11px">关系 '
        + seg.relationIds.join('、') + '</div></div>');
    return `
      <div class="card" style="background:#fff;margin-bottom:10px">
        <h3 style="font-size:14px">第 ${seg.index + 1} 段见证链（${seg.relationCount} 条关系最少；关系 ID 序列 [${seg.relationIds.join(', ')}]）</h3>
        <div class="route-chain">${chain}</div>
      </div>`;
  }).join('');

  const evHtml = r.events
    .map((e) => `
      <div class="item">
        <div class="date">${esc(fmtDate(e.resolvedDate))}</div>
        <div><strong>${esc(e.title)}</strong>
          ${e.isAnchor ? `<span class="badge prec">锚点${e.anchorPositions && e.anchorPositions.length ? '（第 ' + e.anchorPositions.map((p) => p + 1).join('、') + ' 个）' : ''}</span>` : '<span class="badge">链上中间事件</span>'}
          <span class="badge prec">${PREC_LABEL[e.precision] || e.precision}</span>
        </div>
        ${e.description ? `<div class="muted">${esc(e.description)}</div>` : ''}
        <div class="source">
          <b>所选出处：</b>${esc(e.source || '（未注明出处）')}
          <br><span class="muted">原始主张：${esc(e.dateLabel)}
          （覆盖区间 ${e.intervalStart} ~ ${e.intervalEnd}）${e.claimNote ? '；' + esc(e.claimNote) : ''}</span>
        </div>
      </div>`)
    .join('');

  const relHtml = r.relations.length
    ? r.relations.map((rel) => `
        <div class="rel-line">
          <strong>${esc(titleById.get(rel.earlierEventId) || '#' + rel.earlierEventId)}</strong>
          <span class="badge">先于</span>
          <strong>${esc(titleById.get(rel.laterEventId) || '#' + rel.laterEventId)}</strong>
          <span class="muted">（relationId ${rel.relationId}）</span>
          ${rel.source ? `<div class="source"><b>出处：</b>${esc(rel.source)}</div>` : ''}
        </div>`).join('')
    : '<p class="muted">本路线未用到先于关系。</p>';

  $('#routeViewBody').innerHTML = `
    ${r.note ? `<p class="muted">说明：${esc(r.note)}</p>` : ''}
    <h3>逐段见证链</h3>
    ${segHtml}
    <h3>路线涉及的事件（仅 ${r.eventCount} 个）</h3>
    <div class="timeline">${evHtml}</div>
    <h3 style="margin-top:14px">路线涉及的「先于」关系（仅 ${r.relationCount} 条）</h3>
    ${relHtml}`;
}

async function renderRouteList() {
  let data;
  try {
    const res = await fetch('/api/public/routes');
    data = await res.json();
  } catch {
    return; // 静默：年表本身仍可展示
  }
  if (!data.routes || !data.routes.length) return;
  $('#routeListCard').style.display = '';
  $('#routeList').innerHTML = data.routes
    .map((r) => `
      <div class="rel-line">
        <div class="row" style="align-items:center">
          <strong><a href="/?route=${r.routeNo}">#${r.routeNo} ${esc(r.title)}</a></strong>
          <span class="muted" style="flex:1">
            第 ${r.versionNo} 版 · ${r.anchorCount} 锚点 · 涉及 ${r.eventCount} 事件 / ${r.relationCount} 关系
            · ${esc(r.createdAt.replace('T', ' ').slice(0, 16))} UTC
          </span>
          <a class="badge" href="/?route=${r.routeNo}">查看路线</a>
        </div>
        <div class="muted">${r.anchorTitles.map((t) => esc(t)).join(' → ')}</div>
      </div>`)
    .join('');
}

async function renderChronicle() {
  const msg = $('#message');
  const res = await fetch('/api/public/chronicle');
  const data = await res.json();
  if (!data.published) {
    msg.innerHTML = '<div class="alert warn">年表尚未发布任何版本，敬请期待。<br><span class="muted">（草稿中的未发布内容对外不可见）</span></div>';
    $('#versionTag').textContent = '未发布';
    return;
  }
  const v = data.version;
  $('#versionTag').textContent = `第 ${v.versionNo} 版 · 发布于 ${v.publishedAt.replace('T', ' ').slice(0, 16)} UTC · 编辑：${esc(v.editor || '匿名')}`;
  $('#chronicle').style.display = 'grid';
  $('#caveat').textContent = `本页为第 ${v.versionNo} 版不可变快照，共 ${v.eventCount} 个事件、${v.relationCount} 条先后关系。`;

  const titleById = new Map(v.events.map((e) => [e.eventId, e.title]));

  $('#timeline').innerHTML = v.events.map((e) => `
    <div class="item">
      <div class="date">${esc(fmtDate(e.resolvedDate))}</div>
      <div><strong>${esc(e.title)}</strong>
        <span class="badge prec">${PREC_LABEL[e.precision] || e.precision}</span>
      </div>
      ${e.description ? `<div class="muted">${esc(e.description)}</div>` : ''}
      <div class="source">
        <b>所选出处：</b>${esc(e.source || '（未注明出处）')}
        <br><span class="muted">原始主张：${esc(e.dateLabel)}
        （覆盖区间 ${e.intervalStart} ~ ${e.intervalEnd}）${e.claimNote ? '；' + esc(e.claimNote) : ''}</span>
      </div>
    </div>
  `).join('');

  $('#relations').innerHTML = v.relations.length
    ? v.relations.map((r) => `
          <div class="rel-line">
            <strong>${esc(titleById.get(r.earlierEventId) || '#' + r.earlierEventId)}</strong>
            <span class="badge">先于</span>
            <strong>${esc(titleById.get(r.laterEventId) || '#' + r.laterEventId)}</strong>
            ${r.source ? `<div class="source"><b>出处：</b>${esc(r.source)}</div>` : ''}
          </div>`).join('')
    : '<p class="muted">本版未记录先于关系。</p>';
}

async function main() {
  const routeNo = new URLSearchParams(location.search).get('route');
  if (routeNo) {
    await renderRoute(routeNo);
    return;
  }
  await renderChronicle();
  await renderRouteList();
  if (location.hash === '#routes') {
    document.getElementById('routeListCard')?.scrollIntoView();
  }
}

main().catch((err) => {
  $('#message').innerHTML = `<div class="alert error">加载失败：${esc(err.message)}</div>`;
});
