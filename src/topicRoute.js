'use strict';

// 专题「先于」脉络路线：编辑者从某一**已发布版本**挑选至少两个互异事件作为锚点，
// 按给定顺序连接成可公开的「先于」脉络路线。
//
// 规则：
//   - 相邻两个锚点必须在**该版关系图**中存在有向路径（严格沿 earlier → later 方向）；
//   - 每段固定一条**关系数最少**的见证链；同长度（同关系数）按**关系 ID 序列字典序择小**；
//   - 任一段无法连通即**拒绝整条路线**（422 ROUTE_NOT_CONNECTED），并逐一指出断点；
//   - 未知版本 404；未知事件 / 重复事件 / 锚点不足 / 标题为空等参数问题 422 ROUTE_INVALID，
//     以上均**不落库**。
//
// 路线建立后不可变：表里只固定 version_no、锚点顺序与见证链 ID 序列，
// 读出时从该版不可变快照 version_events / version_relations 渲染。
// 因此之后修改草稿、恢复草稿、发布新版本都不会改变任何旧路线。
// 公开读出动态应用 source_redactions（「出处已遮盖」）；持编辑口令可取原文视图。

const { getDb } = require('./db');
const { getVersionDetail } = require('./publish');
const { redactedSourceSet, REDACTED_SOURCE } = require('./redact');

const MAX_TITLE_LEN = 200;
const MAX_NOTE_LEN = 1000;
const MAX_ANCHORS = 200;

function bad400(message) {
  return { status: 400, message };
}

// 归一化标题：必须是非空字符串。
function normalizeTitle(raw) {
  if (typeof raw !== 'string') {
    throw { status: 422, code: 'ROUTE_INVALID', message: '专题标题 title 必须是非空字符串', problems: [] };
  }
  const title = raw.trim();
  if (title === '') {
    throw { status: 422, code: 'ROUTE_INVALID', message: '专题标题不能为空', problems: [] };
  }
  if (title.length > MAX_TITLE_LEN) {
    throw { status: 422, code: 'ROUTE_INVALID', message: `专题标题长度不能超过 ${MAX_TITLE_LEN}`, problems: [] };
  }
  return title;
}

function normalizeNote(raw) {
  const note = raw == null ? '' : raw;
  if (typeof note !== 'string') {
    throw { status: 422, code: 'ROUTE_INVALID', message: 'note 必须是字符串', problems: [] };
  }
  if (note.length > MAX_NOTE_LEN) {
    throw { status: 422, code: 'ROUTE_INVALID', message: `说明长度不能超过 ${MAX_NOTE_LEN}`, problems: [] };
  }
  return note;
}

// 归一化锚点顺序：必须是至少两个**整数**事件 id 的数组（是否存在 / 是否重复由后续校验）。
function normalizeAnchors(raw) {
  if (!Array.isArray(raw)) {
    throw bad400('anchors（锚点顺序）必须是事件 id 数组，如 [1, 3, 2]');
  }
  if (raw.length < 2) {
    throw bad400('一条脉络路线至少要挑选两个（互异）锚点事件');
  }
  if (raw.length > MAX_ANCHORS) {
    throw bad400(`一条脉络路线至多包含 ${MAX_ANCHORS} 个锚点`);
  }
  const anchors = [];
  for (const item of raw) {
    const id = Number(item);
    if (!Number.isInteger(id) || id < 1) {
      throw bad400('anchors 中每一项都必须是正整数事件 id');
    }
    anchors.push(id);
  }
  return anchors;
}

// 构造该版有向图邻接表：from -> [{ to, relationId }]，出边按关系 id 升序。
function buildAdjacency(version) {
  const adj = new Map();
  for (const ev of version.events) adj.set(ev.eventId, []);
  for (const r of version.relations) {
    if (adj.has(r.earlierEventId) && adj.has(r.laterEventId)) {
      adj.get(r.earlierEventId).push({ to: r.laterEventId, relationId: r.relationId });
    }
  }
  for (const edges of adj.values()) edges.sort((a, b) => a.relationId - b.relationId);
  return adj;
}

// 按「关系 ID 序列」字典序比较两条见证链（等长时才比较）。
function relSeqLess(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false; // 完全相等
}

// 在该版关系图中求 from → to 的最短（关系数最少）有向见证链；
// 同长度按关系 ID 序列字典序择小。返回 { eventIds, relationIds } 或 null（不可达）。
//
// 逐层 BFS：只在扩展完一整层后统一提交，对每个目标节点在「长度相同的全部候选」中
// 取关系序列最小者。单元权 + 字典序前缀单调保证最终结果即全局最优。
function shortestWitnessChain(adj, from, to) {
  if (from === to) return { eventIds: [from], relationIds: [] };
  const best = new Map([[from, []]]); // 已定型节点 -> 最优关系 id 序列
  let frontier = [from];
  while (frontier.length) {
    const candidates = new Map(); // 本层新到节点 -> 候选关系序列（同长度取最小）
    for (const node of frontier) {
      const prefix = best.get(node);
      for (const edge of adj.get(node)) {
        if (best.has(edge.to)) continue; // 更短层已定稿，本层候选不可能更优
        const seq = [...prefix, edge.relationId];
        const cur = candidates.get(edge.to);
        if (cur === undefined || relSeqLess(seq, cur)) candidates.set(edge.to, seq);
      }
    }
    if (candidates.size === 0) break;
    for (const [node, seq] of candidates) best.set(node, seq);
    if (best.has(to)) break; // 目标首次到达的层即为最短层，最优序列已确定
    frontier = [...candidates.keys()];
  }
  const seq = best.get(to);
  if (seq === undefined) return null;
  return { eventIds: reconstructEvents(adj, from, to, seq), relationIds: seq };
}

// 由关系 id 序列还原事件序列（版本内关系 id 唯一；平行边也能准确还原）。
function reconstructEvents(adj, from, to, relationIds) {
  const eventIds = [from];
  let cur = from;
  for (const rid of relationIds) {
    const edge = adj.get(cur).find((e) => e.relationId === rid);
    if (!edge) throw new Error('见证链还原失败：关系不属于当前节点的出边');
    eventIds.push(edge.to);
    cur = edge.to;
  }
  if (cur !== to) throw new Error('见证链还原失败：链尾不是目标事件');
  return eventIds;
}

// 校验锚点并逐段求见证链（只读，不落库）。
// 返回 { version, anchors, segments }；参数问题抛 422 ROUTE_INVALID，
// 不可达抛 422 ROUTE_NOT_CONNECTED（断点全部列出）。
function planRoute(versionNoRaw, anchorsRaw) {
  const versionNo = Number(versionNoRaw);
  if (!Number.isInteger(versionNo) || versionNo < 1) {
    throw bad400('versionNo 必须是正整数');
  }
  const anchors = normalizeAnchors(anchorsRaw);
  const version = getVersionDetail(versionNo);
  if (!version) {
    throw { status: 404, message: `版本 ${versionNo} 不存在，无法在其上建立脉络路线` };
  }

  const problems = [];
  const present = new Set(version.events.map((e) => e.eventId));
  const seen = new Set();
  for (const id of anchors) {
    if (!present.has(id)) {
      problems.push({ type: 'unknown_event', eventId: id, message: `事件 ${id} 不在第 ${versionNo} 版中（未知事件或该版未收录）` });
    }
    if (seen.has(id)) {
      problems.push({ type: 'duplicate_event', eventId: id, message: `锚点事件 ${id} 重复出现：同一路线的锚点必须互异` });
    }
    seen.add(id);
  }
  if (problems.length) {
    throw {
      status: 422,
      code: 'ROUTE_INVALID',
      message: '脉络路线参数有误，未建立路线（不落库）',
      versionNo,
      problems,
    };
  }

  const adj = buildAdjacency(version);
  const segments = [];
  const breaks = [];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const from = anchors[i];
    const to = anchors[i + 1];
    const chain = shortestWitnessChain(adj, from, to);
    if (!chain) {
      breaks.push({
        segmentIndex: i,
        fromEventId: from,
        toEventId: to,
        message: `第 ${i + 1} 段断点：第 ${versionNo} 版关系图中，事件 ${from} 到事件 ${to} 不存在有向「先于」路径`,
      });
    } else {
      segments.push({ index: i, fromEventId: from, toEventId: to, eventIds: chain.eventIds, relationIds: chain.relationIds });
    }
  }
  if (breaks.length) {
    throw {
      status: 422,
      code: 'ROUTE_NOT_CONNECTED',
      message: '相邻锚点无法全部沿「先于」方向连通，已拒绝整条路线（不落库）',
      versionNo,
      anchors,
      breaks,
    };
  }
  return { version, anchors, segments };
}

// 建立路线（单事务插入）。返回路线完整详情（原文视图）。
function createTopicRoute({ versionNo, anchorsRaw, titleRaw, noteRaw, editor = '' }) {
  const title = normalizeTitle(titleRaw);
  const note = normalizeNote(noteRaw);
  const { version, anchors, segments } = planRoute(versionNo, anchorsRaw);

  const eventSet = new Set();
  const relSet = new Set();
  for (const seg of segments) {
    seg.eventIds.forEach((id) => eventSet.add(id));
    seg.relationIds.forEach((id) => relSet.add(id));
  }

  const db = getDb();
  const tx = db.transaction(() => {
    // 事务内再确认版本仍存在（版本只追加，正常情况下不会消失）
    const exists = db.prepare('SELECT 1 FROM versions WHERE version_no = ?').get(version.versionNo);
    if (!exists) throw { status: 404, message: `版本 ${version.versionNo} 不存在，无法在其上建立脉络路线` };
    return db
      .prepare(
        `INSERT INTO topic_routes
           (version_no, title, editor, note, anchors_json, segments_json,
            anchor_count, event_count, relation_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        version.versionNo,
        title,
        String(editor || ''),
        note,
        JSON.stringify(anchors),
        JSON.stringify(segments),
        anchors.length,
        eventSet.size,
        relSet.size
      ).lastInsertRowid;
  });
  const id = tx();
  return getTopicRoute(id);
}

// 只读预览（不落库）：返回与建立成功后同构的路线详情（无 routeNo）。
function previewTopicRoute({ versionNo, anchorsRaw, titleRaw, noteRaw, editor = '' }) {
  const title = normalizeTitle(titleRaw);
  const note = normalizeNote(noteRaw);
  const plan = planRoute(versionNo, anchorsRaw);
  return { ok: true, ...renderRouteFromPlan({ ...plan, title, note, editor: String(editor || '') }) };
}

function parseRow(row) {
  if (!row) return null;
  return {
    routeNo: row.id,
    versionNo: row.version_no,
    title: row.title,
    editor: row.editor,
    note: row.note,
    anchors: JSON.parse(row.anchors_json),
    segments: JSON.parse(row.segments_json),
    anchorCount: row.anchor_count,
    eventCount: row.event_count,
    relationCount: row.relation_count,
    createdAt: row.created_at,
  };
}

function getRouteRow(id) {
  return getDb().prepare('SELECT * FROM topic_routes WHERE id = ?').get(id);
}

function getTopicRoute(id) {
  const row = getRouteRow(id);
  if (!row) return null;
  return renderRouteRow(parseRow(row));
}

function listTopicRouteRows() {
  return getDb().prepare('SELECT * FROM topic_routes ORDER BY id DESC').all();
}

// 由计划结果（尚未入库）渲染完整路线：事件 / 关系只含路线涉及者，并标注锚点 / 中间事件。
function renderRouteFromPlan({ version, anchors, segments, title, note, editor = '', routeNo = null, createdAt = null }) {
  const eventMap = new Map(version.events.map((e) => [e.eventId, e]));
  const relMap = new Map(version.relations.map((r) => [r.relationId, r]));

  const anchorPositions = new Map();
  anchors.forEach((id, i) => {
    if (!anchorPositions.has(id)) anchorPositions.set(id, []);
    anchorPositions.get(id).push(i);
  });
  const intermediateSet = new Set();
  for (const seg of segments) {
    seg.eventIds.slice(1, -1).forEach((id) => intermediateSet.add(id));
  }

  // 事件按其在路线中的首次出现顺序排列（只展示路线涉及的事件）
  const eventOrder = [];
  const eventSeen = new Set();
  const relOrder = [];
  const relSeen = new Set();
  for (const seg of segments) {
    for (const id of seg.eventIds) {
      if (!eventSeen.has(id)) { eventSeen.add(id); eventOrder.push(id); }
    }
    for (const id of seg.relationIds) {
      if (!relSeen.has(id)) { relSeen.add(id); relOrder.push(id); }
    }
  }

  const events = eventOrder.map((id) => {
    const e = eventMap.get(id);
    const positions = anchorPositions.get(id) || [];
    return {
      eventId: id,
      title: e.title,
      description: e.description || '',
      claimId: e.claimId,
      precision: e.precision,
      dateLabel: e.dateLabel,
      intervalStart: e.intervalStart,
      intervalEnd: e.intervalEnd,
      resolvedDate: e.resolvedDate,
      source: e.source,
      claimNote: e.claimNote,
      isAnchor: positions.length > 0,
      anchorPositions: positions,
      isIntermediate: intermediateSet.has(id),
    };
  });

  const relations = relOrder.map((id) => {
    const r = relMap.get(id);
    return {
      relationId: id,
      earlierEventId: r.earlierEventId,
      laterEventId: r.laterEventId,
      source: r.source || '',
      note: r.note || '',
    };
  });

  const outSegments = segments.map((seg) => ({
    index: seg.index,
    fromEventId: seg.fromEventId,
    toEventId: seg.toEventId,
    eventIds: seg.eventIds,
    relationIds: seg.relationIds,
    relationCount: seg.relationIds.length,
  }));

  return {
    ...(routeNo !== null ? { routeNo } : {}),
    ...(createdAt !== null ? { createdAt } : {}),
    title,
    editor,
    note,
    versionNo: version.versionNo,
    anchors,
    anchorCount: anchors.length,
    segments: outSegments,
    events,
    relations,
    eventCount: events.length,
    relationCount: relations.length,
  };
}

// 由库中路线行渲染完整路线（原文）。
function renderRouteRow(route) {
  const version = getVersionDetail(route.versionNo);
  if (!version) {
    // 正常业务不会发生（版本快照只追加）；防御性处理
    throw { status: 500, message: `路线 #${route.routeNo} 所固定的第 ${route.versionNo} 版快照缺失` };
  }
  return renderRouteFromPlan({
    version,
    anchors: route.anchors,
    segments: route.segments,
    title: route.title,
    note: route.note,
    editor: route.editor,
    routeNo: route.routeNo,
    createdAt: route.createdAt,
  });
}

// 公开读出层：对已渲染路线的事件 / 关系出处应用遮盖（仅本路线涉及者）。
function applyRedactionToRoute(route, redactedSet = redactedSourceSet()) {
  if (!route || redactedSet.size === 0) return route;
  return {
    ...route,
    events: route.events.map((ev) => ({
      ...ev,
      source: redactedSet.has(ev.source) ? REDACTED_SOURCE : ev.source,
    })),
    relations: route.relations.map((rel) => ({
      ...rel,
      source: redactedSet.has(rel.source) ? REDACTED_SOURCE : rel.source,
    })),
  };
}

// 列表项：不展开事件 / 关系，仅带各锚点标题（从所固定版本快照取）。
function listRouteItem(row) {
  const route = parseRow(row);
  const version = getVersionDetail(route.versionNo);
  const titleByEvent = new Map((version ? version.events : []).map((e) => [e.eventId, e.title]));
  return {
    routeNo: route.routeNo,
    versionNo: route.versionNo,
    title: route.title,
    editor: route.editor,
    note: route.note,
    anchors: route.anchors,
    anchorTitles: route.anchors.map((id) => titleByEvent.get(id) || `#${id}`),
    anchorCount: route.anchorCount,
    eventCount: route.eventCount,
    relationCount: route.relationCount,
    createdAt: route.createdAt,
  };
}

function listTopicRoutes() {
  return listTopicRouteRows().map(listRouteItem);
}

// 公开视图（遮盖后）。
function getPublicTopicRoute(id) {
  const route = getTopicRoute(id);
  if (!route) return null;
  return applyRedactionToRoute(route);
}

function listPublicTopicRoutes() {
  return listTopicRoutes();
}

module.exports = {
  createTopicRoute,
  previewTopicRoute,
  planRoute,
  getTopicRoute,
  getPublicTopicRoute,
  listTopicRoutes,
  listPublicTopicRoutes,
  listRouteItem,
  renderRouteRow,
  applyRedactionToRoute,
  shortestWitnessChain,
  buildAdjacency,
  normalizeAnchors,
};
