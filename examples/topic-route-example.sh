#!/usr/bin/env bash
# 专题「先于」脉络路线端到端调用示例。
#
# 流程：建草稿（含一条直边与两条等长支路，用于演示择链规则）→ 发布版本
#       → 只读预览见证链（不落库）→ 正式建立公开路线
#       → 访客视图（区分锚点 / 中间事件、只含路线涉及内容、出处遮盖）
#       → 编辑口令原文视图 → 错误形态（未知版本 404、未知/重复事件、断点 422）
#       → 改草稿发新版，核对旧路线固定不变。
#
# 依赖：curl 与 node。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/topic-route-example.sh
# 可重复运行（标题带时间戳）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
TS="$(date +%s)"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
latest_no() { curl -s "$BASE/api/public/versions" | jfield 'd.currentVersionNo'; }
http_code() { curl -s -o /tmp/route-example-body.json -w '%{http_code}' "$@"; }

say "0) 口令检查（错误口令应 401）"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" \
  -H 'X-Editor-Token: wrong-token' -d '{"versionNo":1,"anchors":[1,2],"title":"x"}' \
  "$BASE/api/editor/routes/preview")
[ "$code" = 401 ] && echo "OK：错误口令返回 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 建草稿：S 起点、A 支路甲、B 支路乙、T 终点"
S=$(post  "$BASE/api/editor/events" -d '{"title":"路线示例起点 '$TS'"}' | jfield 'd.event.id')
A=$(post  "$BASE/api/editor/events" -d '{"title":"路线示例支路甲 '$TS'"}' | jfield 'd.event.id')
B=$(post  "$BASE/api/editor/events" -d '{"title":"路线示例支路乙 '$TS'"}' | jfield 'd.event.id')
T=$(post  "$BASE/api/editor/events" -d '{"title":"路线示例终点 '$TS'"}' | jfield 'd.event.id')
for E in "$S" "$A" "$B" "$T"; do
  post "$BASE/api/editor/events/$E/claims" \
    -d '{"precision":"year","year":1958,"source":"示例出处 '$TS' 事件'$E'"}' >/dev/null
done
# 关系（按此顺序得到 relationId：S→A, A→T, S→B, B→T, S→T）
post "$BASE/api/editor/relations" -d '{"earlierId":'"$S"',"laterId":'"$A"',"source":"支路甲见证 '$TS'"}' >/dev/null
post "$BASE/api/editor/relations" -d '{"earlierId":'"$A"',"laterId":'"$T"',"source":"支路甲见证 '$TS'"}' >/dev/null
post "$BASE/api/editor/relations" -d '{"earlierId":'"$S"',"laterId":'"$B"',"source":"支路乙见证 '$TS'"}' >/dev/null
post "$BASE/api/editor/relations" -d '{"earlierId":'"$B"',"laterId":'"$T"',"source":"支路乙见证 '$TS'"}' >/dev/null
post "$BASE/api/editor/relations" -d '{"earlierId":'"$S"',"laterId":'"$T"',"source":"直达见证 '$TS'"}' >/dev/null
echo "事件 S=$S A=$A B=$B T=$T（S→T 为 1 条关系直边；经甲 / 经乙均为 2 条关系）"

say "2) 收集主张并发布一个新版本"
SEL=$(curl -s "${h_ed[@]}" "$BASE/api/editor/state" | node -e '
const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const ids=new Set(["'"$S"'","'"$A"'","'"$B"'","'"$T"'"].map(Number));
const sel=d.events.filter(e=>ids.has(e.id)).map(e=>({eventId:e.id,claimId:e.claims[0].id}));
process.stdout.write(JSON.stringify(sel));')
BASE_VER="$(latest_no)"
VER=$(post "$BASE/api/editor/publish" \
  -d '{"selection":'"$SEL"',"baseVersionNo":'"$BASE_VER"',"note":"路线示例版 '$TS'","editor":"示例脚本"}' \
  | jfield 'd.versionNo')
echo "已发布第 $VER 版"

say "3) 只读预览：S → T 的最短见证链应为 1 条关系的直边（不落库）"
post "$BASE/api/editor/routes/preview" \
  -d '{"versionNo":'"$VER"',"anchors":['"$S"','"$T"'],"title":"示例专题（直边）'$TS'","note":"演示用"}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("title =", d.title, " versionNo =", d.versionNo);
for (const s of d.segments)
  console.log(`  第 ${s.index+1} 段：关系数=${s.relationCount} 关系ID序列=[${s.relationIds}] 事件=[${s.eventIds}]`);
if (d.segments[0].relationCount !== 1) { console.error("FAIL：应取 1 条关系的直边"); process.exit(1); }'
ROUTES_BEFORE=$(curl -s "$BASE/api/public/routes" | jfield 'd.routes.length')
echo "预览后公开路线数 = $ROUTES_BEFORE（预览不落库）"

say "4) 正式建立并公开路线（固定版本 / 锚点顺序 / 见证链）"
ROUTE_NO=$(post "$BASE/api/editor/routes" \
  -d '{"versionNo":'"$VER"',"anchors":['"$S"','"$T"'],"title":"示例专题（直边）'$TS'","note":"演示用","editor":"示例脚本"}' \
  | jfield 'd.route.routeNo')
echo "已建立路线 #$ROUTE_NO"

say "5) 再建一条走等长支路的路线：锚点顺序 S → A → T，两段各 1 关系"
ROUTE2_NO=$(post "$BASE/api/editor/routes" \
  -d '{"versionNo":'"$VER"',"anchors":['"$S"','"$A"','"$T"'],"title":"示例专题（经支路甲）'$TS'"}' \
  | jfield 'd.route.routeNo')
curl -s "$BASE/api/public/routes/$ROUTE2_NO" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).route;
console.log("路线 #"+d.routeNo, "段数 =", d.segments.length);
for (const e of d.events) console.log(`  事件 ${e.eventId}「${e.title}」 锚点=${e.isAnchor} 中间=${e.isIntermediate}`);'

say "6) 访客视图（无口令）：区分锚点与链上中间事件，只含路线涉及的事件 / 关系"
curl -s "$BASE/api/public/routes/$ROUTE2_NO" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).route;
console.log(`《${d.title}》 固定第 ${d.versionNo} 版，涉及事件 ${d.eventCount}、关系 ${d.relationCount}`);
for (const s of d.segments)
  console.log(`  第 ${s.index+1} 段 [${s.relationIds}]：${s.eventIds.join(" → ")}`);
for (const e of d.events)
  console.log(`  事件「${e.title}」 ${e.isAnchor?"【锚点】":""}${e.isIntermediate?"【链上中间事件】":""} 出处=${e.source}`);'

say "7) 错误形态：未知版本 404；未知事件 / 重复事件 422；无法连通 422 且指出断点；均不保存"
code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/routes" \
  -d '{"versionNo":999999,"anchors":['"$S"','"$T"'],"title":"x"}')
echo "未知版本 -> HTTP $code（期望 404）"; [ "$code" = 404 ] || exit 1

code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/routes" \
  -d '{"versionNo":'"$VER"',"anchors":['"$S"',999999],"title":"x"}')
echo "未知事件 -> HTTP $code（期望 422 ROUTE_INVALID）：$(node -e 'const d=require("/tmp/route-example-body.json");console.log(d.code, (d.problems||[]).map(p=>p.type).join(","))')"
[ "$code" = 422 ] || exit 1

code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/routes" \
  -d '{"versionNo":'"$VER"',"anchors":['"$S"','"$S"'],"title":"x"}')
echo "重复事件 -> HTTP $code（期望 422 ROUTE_INVALID）：$(node -e 'const d=require("/tmp/route-example-body.json");console.log((d.problems||[]).map(p=>p.type).join(","))')"
[ "$code" = 422 ] || exit 1

# T 无法沿「先于」方向到达 S（方向反了）-> 整条拒绝并指出断点
code=$(http_code -X POST "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/routes" \
  -d '{"versionNo":'"$VER"',"anchors":['"$T"','"$S"'],"title":"反向不通 '$TS'"}')
echo "无法连通 -> HTTP $code（期望 422 ROUTE_NOT_CONNECTED）"
node -e 'const d=require("/tmp/route-example-body.json");
if (d.code!=="ROUTE_NOT_CONNECTED") process.exit(1);
for (const b of d.breaks) console.log("  断点：", b.message);'
[ "$code" = 422 ] || exit 1
echo "（以上失败均不落库）"

say "8) 出处遮盖：登记后访客视图显示「出处已遮盖」，编辑原文视图不变"
SRC="直达见证 $TS"
PREV=$(post "$BASE/api/editor/redaction-preview" -d '{"source":"'"$SRC"'"}')
PREV_NO=$(printf '%s' "$PREV" | jfield 'd.currentVersionNo')
post "$BASE/api/editor/redaction" \
  -d '{"source":"'"$SRC"'","currentVersionNo":'"$PREV_NO"'}' >/dev/null
echo "-- 访客视图路线 #$ROUTE_NO 的关系出处："
curl -s "$BASE/api/public/routes/$ROUTE_NO" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).route;
for (const r of d.relations) console.log("  关系 " + r.relationId + ": [" + r.source + "]");'
echo "-- 编辑口令原文视图路线 #$ROUTE_NO 的关系出处："
curl -s "${h_ed[@]}" "$BASE/api/editor/routes/$ROUTE_NO/raw" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).route;
for (const r of d.relations) console.log("  关系 " + r.relationId + ": [" + r.source + "]");'

say "9) 不可变性：改草稿、发布新版后，旧路线仍固定在旧版内容"
curl -s -X PUT "${h_json[@]}" "${h_ed[@]}" "$BASE/api/editor/events/$S" \
  -d '{"title":"起点（草稿已改名）'$TS'","description":""}' >/dev/null
CUR="$(latest_no)"
post "$BASE/api/editor/publish" -d '{"selection":'"$SEL"',"baseVersionNo":'"$CUR"',"note":"路线示例二版 '$TS'"}' >/dev/null
echo "当前最新版本号 = $(latest_no)，路线 #$ROUTE_NO 仍固定 versionNo=$VER"
curl -s "$BASE/api/public/routes/$ROUTE_NO" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).route;
console.log("  路线 versionNo =", d.versionNo, " 起点标题 =", d.events.find(e=>e.eventId==='"$S"').title);
if (d.versionNo !== '"$VER"') process.exit(1);'

say "10) 公开路线清单"
curl -s "$BASE/api/public/routes" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("当前最新版本号 =", d.currentVersionNo, " 公开路线数 =", d.routes.length);
for (const r of d.routes.filter(x=>x.title.includes("'$TS'")))
  console.log(`  #${r.routeNo}《${r.title}》 固定第 ${r.versionNo} 版：${r.anchorTitles.join(" → ")}`);'

say "全部断言通过 ✅"
echo "浏览器查看：$BASE/?route=$ROUTE_NO （访客）；$BASE/editor 的「专题『先于』脉络路线」卡片（选择与查看）"
