'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');
const { REDACTED_SOURCE } = require('../src/redact');
const { shortestWitnessChain, buildAdjacency } = require('../src/topicRoute');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM topic_routes;
    DELETE FROM source_redactions;
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title) {
  const r = await call('POST', '/api/editor/events', { body: { title } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}

async function makeClaim(eventId, source = 's') {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, {
    body: { precision: 'year', year: 1958, source },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}

async function makeRel(earlierId, laterId, source = 'relsrc') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId, laterId, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}

function claimIdOf(eventId) {
  return mem.prepare('SELECT id FROM claims WHERE event_id = ?').get(eventId).id;
}

async function selectionFor(eventIds) {
  return eventIds.map((id) => ({ eventId: id, claimId: claimIdOf(id) }));
}

async function publishOne(selection, baseVersionNo = 0, note = '') {
  const r = await call('POST', '/api/editor/publish', { body: { selection, baseVersionNo, note } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

async function buildDiamond() {
  // S → A → T、S → B → T（长度均 2），另有 S → T（长度 1）
  // 关系 id 顺序：1:S→A, 2:A→T, 3:S→B, 4:B→T, 5:S→T
  const s = await makeEvent('起点');
  const a = await makeEvent('支路甲');
  const b = await makeEvent('支路乙');
  const t = await makeEvent('终点');
  const ids = { s, a, b, t };
  const r1 = await makeRel(s, a);
  const r2 = await makeRel(a, t);
  const r3 = await makeRel(s, b);
  const r4 = await makeRel(b, t);
  const r5 = await makeRel(s, t);
  Object.assign(ids, { r1, r2, r3, r4, r5 });
  const claims = {};
  for (const id of [s, a, b, t]) claims[id] = await makeClaim(id);
  await publishOne(
    [s, a, b, t].map((id) => ({ eventId: id, claimId: claims[id] })),
    0,
    '菱形图'
  );
  return ids;
}

test('最短见证链：直边优先；同长度按关系 ID 序列字典序择小', () => {
  // 单元测试直接验证 BFS 择链规则
  const edges = [
    { relationId: 1, earlierEventId: 1, laterEventId: 2 },
    { relationId: 2, earlierEventId: 2, laterEventId: 4 },
    { relationId: 3, earlierEventId: 1, laterEventId: 3 },
    { relationId: 4, earlierEventId: 3, laterEventId: 4 },
    { relationId: 5, earlierEventId: 1, laterEventId: 4 },
  ];
  const version = {
    events: [1, 2, 3, 4].map((eventId) => ({ eventId })),
    relations: edges,
  };
  const adj = buildAdjacency(version);
  // 直边 1→4 长度 1，胜过两条长度 2 的路径
  assert.deepStrictEqual(shortestWitnessChain(adj, 1, 4), { eventIds: [1, 4], relationIds: [5] });

  // 去掉直边后，长度同为 2：[1,2] 与 [3,4] 字典序择 [1,2]
  const version2 = {
    events: [1, 2, 3, 4].map((eventId) => ({ eventId })),
    relations: edges.filter((e) => e.relationId !== 5),
  };
  const adj2 = buildAdjacency(version2);
  assert.deepStrictEqual(shortestWitnessChain(adj2, 1, 4), { eventIds: [1, 2, 4], relationIds: [1, 2] });

  // 平行边同起点终点：择关系 id 较小者
  const version3 = {
    events: [1, 4].map((eventId) => ({ eventId })),
    relations: [
      { relationId: 9, earlierEventId: 1, laterEventId: 4 },
      { relationId: 7, earlierEventId: 1, laterEventId: 4 },
    ],
  };
  const adj3 = buildAdjacency(version3);
  assert.deepStrictEqual(shortestWitnessChain(adj3, 1, 4), { eventIds: [1, 4], relationIds: [7] });

  // 不可达返回 null
  const version4 = {
    events: [1, 2].map((eventId) => ({ eventId })),
    relations: [{ relationId: 1, earlierEventId: 2, laterEventId: 1 }],
  };
  const adj4 = buildAdjacency(version4);
  assert.strictEqual(shortestWitnessChain(adj4, 1, 2), null);
});

test('建立路线（含中间事件的多段路线）：访客视图区分锚点与中间事件、只展示路线涉及内容', async () => {
  // 图：e1→e2→e3→e4
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  const e3 = await makeEvent('丙');
  const e4 = await makeEvent('丁');
  const r1 = await makeRel(e1, e2, '出处一');
  const r2 = await makeRel(e2, e3, '出处二');
  const r3 = await makeRel(e3, e4, '出处三');
  const claims = {};
  for (const id of [e1, e2, e3, e4]) claims[id] = await makeClaim(id, '主张出处');
  await publishOne([e1, e2, e3, e4].map((id) => ({ eventId: id, claimId: claims[id] })));

  // 先预览（只读，不落库）
  const preview = await call('POST', '/api/editor/routes/preview', {
    body: { versionNo: 1, anchors: [e1, e4], title: '  甲到丁专题  ', note: 'n' },
  });
  assert.strictEqual(preview.status, 200, JSON.stringify(preview.json));
  assert.strictEqual(preview.json.ok, true);
  assert.strictEqual(preview.json.title, '甲到丁专题'); // 首尾空白去除
  assert.deepStrictEqual(preview.json.anchors, [e1, e4]);
  assert.deepStrictEqual(preview.json.segments[0].relationIds, [r1, r2, r3]);
  assert.deepStrictEqual(preview.json.segments[0].eventIds, [e1, e2, e3, e4]);
  const listBefore = await call('GET', '/api/public/routes', { token: null });
  assert.strictEqual(listBefore.json.routes.length, 0);

  // 正式建立
  const created = await call('POST', '/api/editor/routes', {
    body: { versionNo: 1, anchors: [e1, e4], title: '甲到丁专题', note: 'n', editor: '编者' },
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.json));
  const no = created.json.route.routeNo;
  assert.strictEqual(no, 1);
  assert.strictEqual(created.json.route.versionNo, 1);
  assert.strictEqual(created.json.route.eventCount, 4);
  assert.strictEqual(created.json.route.relationCount, 3);

  const pub = await call('GET', `/api/public/routes/${no}`, { token: null });
  assert.strictEqual(pub.status, 200);
  const r = pub.json.route;
  const byId = new Map(r.events.map((e) => [e.eventId, e]));
  assert.strictEqual(byId.get(e1).isAnchor, true);
  assert.strictEqual(byId.get(e4).isAnchor, true);
  assert.strictEqual(byId.get(e2).isAnchor, false);
  assert.strictEqual(byId.get(e2).isIntermediate, true);
  assert.strictEqual(byId.get(e3).isIntermediate, true);
  assert.strictEqual(byId.get(e1).isIntermediate, false);
  assert.deepStrictEqual(byId.get(e1).anchorPositions, [0]);
  // 只含路线涉及的事件 / 关系
  assert.strictEqual(r.events.length, 4);
  assert.strictEqual(r.relations.length, 3);

  // 多锚点路线：e1→e3、e3→e4；e3 既锚点又在链上角色
  const created2 = await call('POST', '/api/editor/routes', {
    body: { versionNo: 1, anchors: [e1, e3, e4], title: '分段专题' },
  });
  assert.strictEqual(created2.status, 201, JSON.stringify(created2.json));
  const r2view = (await call('GET', `/api/public/routes/${created2.json.route.routeNo}`, { token: null })).json.route;
  assert.strictEqual(r2view.segments.length, 2);
  assert.deepStrictEqual(r2view.segments[0].relationIds, [r1, r2]);
  assert.deepStrictEqual(r2view.segments[1].relationIds, [r3]);
  const e3v = r2view.events.find((e) => e.eventId === e3);
  assert.strictEqual(e3v.isAnchor, true);
  assert.deepStrictEqual(e3v.anchorPositions, [1]);
});

test('HTTP 端到端：菱形图择最短直边；预览与正式建立一致', async () => {
  const d = await buildDiamond();
  const created = await call('POST', '/api/editor/routes', {
    body: { versionNo: 1, anchors: [d.s, d.t], title: '直达专题' },
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.json));
  assert.deepStrictEqual(created.json.route.segments[0].relationIds, [d.r5]); // 长度 1 胜出
  assert.deepStrictEqual(created.json.route.segments[0].eventIds, [d.s, d.t]);
});

test('无法连通：拒绝整条路线并指出断点（不落库）', async () => {
  const e1 = await makeEvent('左');
  const e2 = await makeEvent('中');
  const e3 = await makeEvent('右');
  for (const id of [e1, e2, e3]) await makeClaim(id);
  await makeRel(e1, e2); // e3 与图无连接
  await publishOne(await selectionFor([e1, e2, e3]));

  const r = await call('POST', '/api/editor/routes', {
    body: { versionNo: 1, anchors: [e1, e2, e3], title: '不通的专题' },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.code, 'ROUTE_NOT_CONNECTED');
  assert.strictEqual(r.json.breaks.length, 1);
  assert.strictEqual(r.json.breaks[0].fromEventId, e2);
  assert.strictEqual(r.json.breaks[0].toEventId, e3);
  assert.match(r.json.breaks[0].message, /断点/);
  const list = await call('GET', '/api/public/routes', { token: null });
  assert.strictEqual(list.json.routes.length, 0);

  // 反向也不通（方向错误）：e2→e1 无路径
  const r2 = await call('POST', '/api/editor/routes/preview', {
    body: { versionNo: 1, anchors: [e2, e1], title: '反向专题' },
  });
  assert.strictEqual(r2.status, 422);
  assert.strictEqual(r2.json.code, 'ROUTE_NOT_CONNECTED');
});

test('参数错误：未知版本 404；未知事件 / 重复事件 / 空标题 422 ROUTE_INVALID；结构错误 400；均不保存', async () => {
  const e1 = await makeEvent('一');
  const e2 = await makeEvent('二');
  for (const id of [e1, e2]) await makeClaim(id);
  await makeRel(e1, e2);
  await publishOne(await selectionFor([e1, e2]));

  const unknownVersion = await call('POST', '/api/editor/routes', {
    body: { versionNo: 99, anchors: [e1, e2], title: 'x' },
  });
  assert.strictEqual(unknownVersion.status, 404);

  const unknownEvent = await call('POST', '/api/editor/routes', {
    body: { versionNo: 1, anchors: [e1, 999], title: 'x' },
  });
  assert.strictEqual(unknownEvent.status, 422);
  assert.strictEqual(unknownEvent.json.code, 'ROUTE_INVALID');
  assert.ok(unknownEvent.json.problems.some((p) => p.type === 'unknown_event'));

  const dup = await call('POST', '/api/editor/routes', {
    body: { versionNo: 1, anchors: [e1, e1], title: 'x' },
  });
  assert.strictEqual(dup.status, 422);
  assert.ok(dup.json.problems.some((p) => p.type === 'duplicate_event'));

  const emptyTitle = await call('POST', '/api/editor/routes', {
    body: { versionNo: 1, anchors: [e1, e2], title: '   ' },
  });
  assert.strictEqual(emptyTitle.status, 422);
  assert.strictEqual(emptyTitle.json.code, 'ROUTE_INVALID');

  const tooFew = await call('POST', '/api/editor/routes', {
    body: { versionNo: 1, anchors: [e1], title: 'x' },
  });
  assert.strictEqual(tooFew.status, 400);

  const badAnchor = await call('POST', '/api/editor/routes', {
    body: { versionNo: 1, anchors: [e1, 'x'], title: 'x' },
  });
  assert.strictEqual(badAnchor.status, 400);

  const list = await call('GET', '/api/public/routes', { token: null });
  assert.strictEqual(list.json.routes.length, 0);
});

test('路线不可变：之后改草稿、发新版均不改旧路线（旧路线仍读旧版内容与旧关系 id）', async () => {
  const e1 = await makeEvent('老标题');
  const e2 = await makeEvent('老二');
  for (const id of [e1, e2]) await makeClaim(id, '原始出处');
  await makeRel(e1, e2, '原始关系出处');
  const v1 = await publishOne(
    await selectionFor([e1, e2]),
    0
  );

  const created = await call('POST', '/api/editor/routes', {
    body: { versionNo: 1, anchors: [e1, e2], title: '固定专题' },
  });
  assert.strictEqual(created.status, 201);
  const routeNo = created.json.route.routeNo;

  // 改草稿标题并发布第 2 版
  await call('PUT', `/api/editor/events/${e1}`, { body: { title: '新标题', description: '' } });
  const v2 = await publishOne(
    await selectionFor([e1, e2]),
    1,
    '二版'
  );
  assert.strictEqual(v2.versionNo, 2);

  const view = await call('GET', `/api/public/routes/${routeNo}`, { token: null });
  assert.strictEqual(view.status, 200);
  assert.strictEqual(view.json.route.versionNo, 1);
  assert.strictEqual(view.json.route.events[0].title, '老标题');
  assert.strictEqual(view.json.route.events[0].source, '原始出处');
  // 最新年表已是新标题
  const chronicle = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(chronicle.json.currentVersionNo, 2);
  assert.strictEqual(chronicle.json.version.events.find((e) => e.eventId === e1).title, '新标题');

  // 清单中版本固定标注
  const list = (await call('GET', '/api/public/routes', { token: null })).json.routes;
  assert.strictEqual(list[0].versionNo, 1);
  assert.deepStrictEqual(list[0].anchorTitles, ['老标题', '老二']);
});

test('出处遮盖：路线公开视图显示「出处已遮盖」，编辑原文视图仍显示原文', async () => {
  const e1 = await makeEvent('甲');
  const e2 = await makeEvent('乙');
  await makeClaim(e1, '敏感出处');
  await makeClaim(e2, '普通出处');
  await makeRel(e1, e2, '敏感关系出处');
  await publishOne(
    await selectionFor([e1, e2])
  );
  const created = await call('POST', '/api/editor/routes', {
    body: { versionNo: 1, anchors: [e1, e2], title: '遮盖专题' },
  });
  const routeNo = created.json.route.routeNo;

  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: '敏感出处' } });
  await call('POST', '/api/editor/redaction', {
    body: { source: '敏感出处', currentVersionNo: preview.json.currentVersionNo },
  });
  const preview2 = await call('POST', '/api/editor/redaction-preview', { body: { source: '敏感关系出处' } });
  await call('POST', '/api/editor/redaction', {
    body: { source: '敏感关系出处', currentVersionNo: preview2.json.currentVersionNo },
  });

  const pub = (await call('GET', `/api/public/routes/${routeNo}`, { token: null })).json.route;
  assert.strictEqual(pub.events.find((e) => e.eventId === e1).source, REDACTED_SOURCE);
  assert.strictEqual(pub.events.find((e) => e.eventId === e2).source, '普通出处');
  assert.strictEqual(pub.relations[0].source, REDACTED_SOURCE);

  // 持口令的原文视图
  const raw = await call('GET', `/api/editor/routes/${routeNo}/raw`);
  assert.strictEqual(raw.status, 200);
  assert.strictEqual(raw.json.route.events.find((e) => e.eventId === e1).source, '敏感出处');
  assert.strictEqual(raw.json.route.relations[0].source, '敏感关系出处');

  // 未持口令访问编辑原文 → 401
  const noToken = await call('GET', `/api/editor/routes/${routeNo}/raw`, { token: null });
  assert.strictEqual(noToken.status, 401);
});

test('路线号 / 路线不存在的错误形态', async () => {
  assert.strictEqual((await call('GET', '/api/public/routes/abc', { token: null })).status, 400);
  assert.strictEqual((await call('GET', '/api/public/routes/7', { token: null })).status, 404);
  assert.strictEqual((await call('GET', '/api/editor/routes/7/raw')).status, 404);
});
