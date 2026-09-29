/**
 * 湖州环评公示监测 —— Cloudflare Worker 免费配额版
 * ===================================================================
 * 与付费版的根本区别：
 *   Workers Free 计划 **每次调用 CPU 只有 10ms**（HTTP 请求和 Cron Trigger 都一样），
 *   而实测抓一个栏目列表约 1~3ms、解析一条公告详情约 3~12ms —— 整个流程塞进
 *   一次调用必然超限报错。
 *
 * 所以本版本把流程拆成「极小的单元任务」，用自调用链逐个消化：
 *
 *   cron(每天1次, 本身<1ms CPU)
 *     → 生成 16 个 list 任务写进 KV 队列
 *     → /api/step 取 1 个任务执行 → 写完 KV → fetch 自己继续下一个任务
 *     → 队列空了就停止
 *
 *   每个 /api/step 的 CPU 都控制在 3ms 以内，稳稳跑在免费额度里。
 *
 * 其他省 CPU 的手段：
 *   - 数据按月份分片存 KV，避免每次 JSON.parse/stringify 整个 300KB 大对象
 *   - 详情解析用 indexOf 精准切出表格片段再解析，不做全页正则扫描
 *   - 看板改成客户端渲染：Worker 返回静态 HTML 外壳（几乎 0 CPU），
 *     浏览器再拉 /api/items 由前端渲染
 *
 * 端点：
 *   GET  /            看板页面（静态外壳）
 *   GET  /api/items   按月取数据，?months=2026-09,2026-08
 *   GET  /api/status  运行状态 / 队列长度
 *   POST /api/start   手动启动一轮采集（需 X-Admin-Token）
 *   POST /api/step    自调用的执行单元（内部用，需 X-Admin-Token）
 */

const BASE = 'https://hbj.huzhou.gov.cn';
const LIST_API = BASE +
  '/api-gateway/jpaas-publish-server/front/page/build/unit' +
  '?parseType=bulidstatic&webId=3630&tplSetId=5HrZiFGOR8vHklhTYqM4B' +
  '&pageType=column&tagId={tag}&editType=null&pageId={col}';
const ALT_TAGS = ['zw', 'list'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36';

const COLUMNS = {
  '1229208550': ['市局', '非辐环评审批'],
  '1229208551': ['吴兴分局', '非辐环评审批'],
  '1229208552': ['南太湖新区分局', '非辐环评审批'],
  '1229208553': ['南浔分局', '非辐环评审批'],
  '1229208554': ['德清分局', '非辐环评审批'],
  '1229208555': ['长兴分局', '非辐环评审批'],
  '1229208556': ['安吉分局', '非辐环评审批'],
  '1229691710': ['长合分局', '非辐环评审批'],
  '1229208558': ['市局', '辐射项目审批'],
  '1229208559': ['吴兴分局', '辐射项目审批'],
  '1229208560': ['南浔分局', '辐射项目审批'],
  '1229208561': ['德清分局', '辐射项目审批'],
  '1229208562': ['长兴分局', '辐射项目审批'],
  '1229208563': ['安吉分局', '辐射项目审批'],
  '1229208564': ['南太湖新区分局', '辐射项目审批'],
  '1229858680': ['全市', '建设项目环评信息公示'],
};
const COL_IDS = Object.keys(COLUMNS);

const ART_RE = /href="(\/col\/col\d+\/art\/(\d+)\/art_([0-9a-zA-Z]+)\.html)"[^>]*>\s*([^<]+)<\/a>/g;
const DATE_RE = /class="time"[^>]*>\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2})/g;
const CELL_RE = /<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi;

/* ------------------------------------------------------------ 工具 */

const pad2 = (n) => String(n).padStart(2, '0');

function cstNow() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
const cstDate = () => cstNow().slice(0, 10);
const monthOf = (d) => (d || cstDate()).slice(0, 7);

function stripTagsUtf(s) {
  // 比 decodeEntities 便宜：只处理政务页面里实际会出现的几个实体
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

/** 只处理小片段，成本很低 */
function clean(s) {
  if (!s) return '';
  let t = s.replace(/\u3000/g, ' ').replace(/<[^>]*>/g, ' ');
  if (t.includes('&')) t = stripTagsUtf(t);
  if (!t) return '';
  // 政务站点常见的断字/排版空格，一并清掉（也能提高看板里的搜索命中率）：
  //   "20 2 6 年"      → "2026年"   （数字被空格切断）
  //   "2026 年 9 月"   → "2026年9月"（日期排版）
  //   "1700 台"        → "1700台"   （数字与量词之间）
  if (/\d\s+[\d\u4e00-\u9fa5]/.test(t)) {
    t = t.replace(/(\d)\s+(?=\d)/g, '$1')
      .replace(/(\d)\s+(?=[\u4e00-\u9fa5])/g, '$1')
      .replace(/([\u4e00-\u9fa5])\s+(?=\d)/g, '$1');
  }
  return t.replace(/\s+/g, ' ').trim();
}

const guessType = (title) => {
  if (title.includes('拟对') || title.includes('拟作出')) return '拟审批公示';
  if (title.includes('审批决定')) return '审批决定公告';
  if (title.includes('受理')) return '受理公告';
  if (title.includes('信息公示')) return '环评信息公示';
  return '其他公告';
};

/**
 * 判断链接是不是附件。
 * 官网把文件名藏在 query 里，只看 split('?')[0] 会全部漏判：
 *   /api-gateway/jpaas-web-server/front/document/download
 *       ?fileUrl=xxxxx&fileName=%E5%85%AC%E7%A4%BA%E7%A8%BF.zip
 */
const ATTACH_EXT = ['.pdf', '.doc', '.docx', '.zip', '.rar', '.xls', '.xlsx', '.7z'];

function looksLikeFile(u) {
  if (!u) return false;
  const low = u.toLowerCase();
  const path = low.split('?')[0];
  for (const e of ATTACH_EXT) if (path.endsWith(e)) return true;
  const m = low.match(/[?&]filename=([^&]+)/);
  return !!(m && ATTACH_EXT.some((e) => decodeURIComponent(m[1]).endsWith(e)));
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

/* ------------------------------------------------------------ 列表单元 */

/** 抓一个栏目，产出 entry 列表。单次 CPU 约 1ms */
async function fetchColumn(colId, limit) {
  let html = '';
  for (const tag of ALT_TAGS) {
    try {
      const j = JSON.parse(await fetchText(LIST_API.replace('{tag}', tag).replace('{col}', colId)));
      const chunk = j?.data?.html ?? '';
      if (chunk.length > html.length) html = chunk;
      if (html.includes('art_')) break;
    } catch { /* 换 tag 再试 */ }
  }
  if (!html.includes('art_')) return [];

  const arts = [...html.matchAll(ART_RE)];
  const dates = [...html.matchAll(DATE_RE)];
  const [unit, category] = COLUMNS[colId] ?? ['未知', '未知'];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < arts.length && out.length < limit; i++) {
    const m = arts[i];
    const artId = m[3];
    if (seen.has(artId)) continue;
    seen.add(artId);
    out.push({
      art_id: artId,
      col_id: colId,
      unit,
      category,
      title: clean(m[4]),
      list_date: dates[i]?.[1]?.replace(/\//g, '-') ?? '',
      url: BASE + m[1],
    });
  }
  return out;
}

/* ------------------------------------------------------------ 详情单元 */

/** 从 tStart 处的 <table> 起做标签配对，取出完整表格片段 */
function sliceTable(html, tStart) {
  if (tStart < 0) return '';
  let depth = 0;
  let i = tStart;
  const limit = Math.min(html.length, tStart + 400000);
  while (i < limit) {
    const open = html.indexOf('<table', i);
    const close = html.indexOf('</table', i);
    if (close < 0) break;
    if (open >= 0 && open < close) {
      depth++;
      i = open + 6;
    } else {
      depth--;
      i = close + 8;
      if (depth === 0) return html.slice(tStart, close + 8);
    }
  }
  return html.slice(tStart, i);
}

/** 用 indexOf 切 tr，比正则 matchAll 便宜得多 */
function sliceRows(seg) {
  const rows = [];
  let i = 0;
  while (rows.length < 200) {
    const s = seg.indexOf('<tr', i);
    if (s < 0) break;
    const e = seg.indexOf('</tr>', s);
    if (e < 0) break;
    rows.push(seg.slice(s, e + 5));
    i = e + 5;
  }
  return rows;
}

function rowCells(row, base) {
  const cells = [];
  CELL_RE.lastIndex = 0;
  let m;
  while ((m = CELL_RE.exec(row))) {
    if (m[3].includes('<table')) continue;
    const txt = clean(m[3]);          // 复用同一套清洗规则，避免逻辑漂移
    const cs = m[2].match(/colspan\s*=\s*"?(\d+)"?/i);
    const span = Math.max(1, parseInt(cs?.[1] ?? '1', 10) || 1);
    for (let k = 0; k < span; k++) cells.push(txt);
  }
  void base;
  return cells;
}

const HEADERS = [
  ['项目名称', 'name'],
  ['建设地点', 'loc'],
  ['建设单位', 'org'],
  ['环评机构', 'inst'],
  ['环评编制单位', 'inst'],
  ['受理日期', 'date'],
  ['公示日期', 'date'],
  ['环评文件', 'file'],
  ['建设内容', 'note'],
  ['项目概况', 'note'],
];

/** 解析详情页面里的项目明细表。单次处理通常 <2ms CPU */
function parseProjects(html) {
  const hi = html.indexOf('项目名称');
  if (hi < 0) return [];

  // 取「包含首个 项目名称 的最内层表格」：从最近的 <table 开始，向后配对
  const tStart = html.lastIndexOf('<table', hi);
  const seg = sliceTable(html, tStart);
  if (!seg) return [];

  // 若片段里还有嵌套子表且子表也有 项目名称，往里钻一层
  const subIdx = seg.indexOf('<table', 1);
  if (subIdx > 0) {
    const inner = sliceTable(seg, subIdx);
    if (inner && inner.includes('项目名称')) return collectRows(inner);
  }
  return collectRows(seg);
}

function collectRows(seg) {
  const rows = sliceRows(seg);
  let keys = null;
  let start = -1;
  for (let i = 0; i < rows.length; i++) {
    const cells = rowCells(rows[i]);
    if (cells.some((c) => c === '项目名称' || c.includes('项目名称')) &&
        cells.some((c) => c.includes('建设单位') || c.includes('建设地点') || c.includes('环评机构'))) {
      keys = cells.map((c) => {
        for (const [kw, key] of HEADERS) if (c.includes(kw)) return key;
        return /^序\s*号$/.test(c) ? 'idx' : null;
      });
      start = i;
      break;
    }
  }
  if (!keys) return [];

  const ncol = keys.length;
  const projects = [];
  for (let i = start + 1; i < rows.length; i++) {
    const row = rows[i];
    const cells = rowCells(row);
    if (cells.length !== ncol) continue;

    const rec = {};
    let name = '';
    for (let c = 0; c < ncol; c++) {
      const k = keys[c];
      if (!k || k === 'idx' || k === 'file') continue;
      const v = cells[c];
      if (!v) continue;
      rec[k] = v;
      if (k === 'name') name = v;
    }
    if (!name || name === '项目名称' || /^\d{1,3}$/.test(name)) continue;

    const hrefs = row.match(/href="([^"]+)"/g);
    if (hrefs) {
      const files = [];
      for (const h of hrefs) {
        const u = h.slice(6, -1);
        if (looksLikeFile(u)) files.push(u.startsWith('/') ? BASE + u : u);
      }
      if (files.length) rec.files = files;
    }
    projects.push(rec);
  }
  return projects;
}

/** 解析一条公告详情 */
async function fetchDetail(entry) {
  const html = await fetchText(entry.url);

  // 发布日期：先找页面里的「时间：xxxx-xx-xx」
  let date = '';
  const ti = html.indexOf('时间');
  if (ti >= 0) {
    const m = html.slice(ti, ti + 60).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) date = m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
  }
  if (!date) {
    const m = entry.title.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (m) date = m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
  }
  if (!date) date = entry.list_date || '';

  const projects = parseProjects(html);
  let area = '';
  for (const p of projects) {
    const hay = (p.loc || '') + (p.name || '');
    for (const a of ['吴兴', '南浔', '德清', '长兴', '安吉', '南太湖新区']) {
      if (hay.includes(a) && !area.includes(a)) area = area ? area + '/' + a : a;
    }
  }
  if (!area) area = entry.unit.replace('分局', '');

  return {
    art_id: entry.art_id,
    title: entry.title,
    url: entry.url,
    date,
    unit: entry.unit,
    category: entry.category,
    type: guessType(entry.title),
    area,
    projects,
    fetched_at: cstNow(),
  };
}

/* ------------------------------------------------------------ KV 分片存储 */

const K = {
  pending: 'pending',      // 任务队列
  idx: 'idx',              // 月份清单 + 运行状态
  month: (m) => 'm:' + m,  // 按月分片的数据
};

async function getPending(env) {
  return (await env.EPI_KV.get(K.pending, 'json')) ?? [];
}
async function getIdx(env) {
  return (await env.EPI_KV.get(K.idx, 'json')) ?? { months: [], meta: {} };
}

/** 相邻月份，用来防止「列表日期」和「发布日期」跨月导致的重复入库 */
function neighborMonths(m) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1, 1));
  const prev = new Date(d.getTime() - 86400000);
  const next = new Date(d.getTime() + 32 * 86400000);
  const fm = (x) => x.toISOString().slice(0, 7);
  return [m, fm(prev), fm(next)];
}

/** 分区去重也做穿孔保护：同一 art_id 落在别的月份分片里也算已完成 */
async function hasItem(env, artId, months) {
  const parts = await Promise.all([...new Set(months)].map((m) => env.EPI_KV.get(K.month(m), 'json')));
  for (const arr of parts) {
    if (Array.isArray(arr) && arr.some((x) => x.art_id === artId)) return true;
  }
  return false;
}

/** 某几个月里已入库的全部 art_id，用来判断哪些是新的 */
async function knownIds(env, months) {
  const parts = await Promise.all([...new Set(months)].map((m) => env.EPI_KV.get(K.month(m), 'json')));
  const set = new Set();
  for (const arr of parts) if (Array.isArray(arr)) for (const x of arr) set.add(x.art_id);
  return set;
}

/**
 * 把一条公告写进所属月份分片 —— 只读/写那一个小分片，
 * 不做全量 JSON.parse/stringify，这是能在 10ms CPU 内跑完的关键。
 * 每次写 1~2 个 key（新的月份才额外更新 idx）。
 */
async function appendItem(env, item) {
  const m = monthOf(item.date || undefined);
  const key = K.month(m);
  const arr = (await env.EPI_KV.get(key, 'json')) ?? [];
  if (!arr.some((x) => x.art_id === item.art_id)) arr.push(item);
  await env.EPI_KV.put(key, JSON.stringify(arr));

  const idx = await getIdx(env);
  if (!idx.months.includes(m)) {
    idx.months.push(m);
    idx.months.sort().reverse();
    await env.EPI_KV.put(K.idx, JSON.stringify(idx));
  }
}

/* ------------------------------------------------------------ 单元任务 executor */

/**
 * 取一个任务执行。这是整个系统的心脏，必须保持轻量。
 * 返回 { ok, kind, rest }
 */
async function runOneTask(env) {
  const pending = await getPending(env);
  if (!pending.length) return { done: true, rest: 0 };

  const task = pending[0];
  const rest = pending.slice(1);

  if (task.t === 'list') {
    const entries = await fetchColumn(task.col, task.limit ?? 12);
    const months = new Set();
    for (const e of entries) {
      for (const m of neighborMonths(monthOf(e.list_date || undefined))) months.add(m);
    }
    const known = await knownIds(env, [...months]);
    const fresh = entries.filter((e) => !known.has(e.art_id));
    const next = [...fresh.map((e) => ({ t: 'detail', e })), ...rest];
    await env.EPI_KV.put(K.pending, JSON.stringify(next));
    return { kind: 'list', col: task.col, found: entries.length, queued: fresh.length, rest: next.length };
  }

  if (task.t === 'detail') {
    // 二次确认：有可能被队列里的其它任务已经写进去了
    const already = await hasItem(env, task.e.art_id, neighborMonths(monthOf(task.e.list_date || cstDate())));
    await env.EPI_KV.put(K.pending, JSON.stringify(rest));
    if (already) {
      return { kind: 'detail', skipped: true, art_id: task.e.art_id, rest: rest.length };
    }

    let item = null;
    let err = null;
    try {
      item = await fetchDetail(task.e);
    } catch (e) {
      err = String(e);
    }
    if (item) await appendItem(env, item);
    return { kind: 'detail', ok: !!item, art_id: task.e.art_id, unit: item?.unit, projects: item?.projects?.length ?? 0, err, rest: rest.length };
  }

  await env.EPI_KV.put(K.pending, JSON.stringify(rest));
  return { kind: 'unknown', rest: rest.length };
}

/** 处理 n 个任务（n 由 CPU 预算决定，详情任务建议 2~3 个/次） */
async function runBatch(env, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = await runOneTask(env);
    if (r.done) break;
    out.push(r);
    if (i === n - 1 || r.rest === 0) break;
  }
  // 运行元信息：队列跑完时才写，避免每天几百次无谓写入
  if (!out.length || out[out.length - 1].rest === 0) {
    const idx = await getIdx(env);
    idx.meta.lastTaskAt = cstNow();
    idx.meta.runs = (idx.meta.runs || 0) + out.length;
    const failed = out.filter((r) => r.err);
    if (failed.length) idx.meta.lastError = failed.slice(0, 2);
    await env.EPI_KV.put(K.idx, JSON.stringify(idx));
  }
  return out;
}

/** 启动新一轮：把 16 个栏目作为 list 任务写进队列 */
async function startCycle(env, opts = {}) {
  const idx = await getIdx(env);
  const today = cstDate();
  const force = opts.force === true;
  if (!force && idx.meta.lastScan === today) {
    return { started: false, reason: '今天已经扫过一轮了', pending: (await getPending(env)).length };
  }
  const limit = Number(opts.limit ?? env.LIST_LIMIT ?? 12);
  const pending = await getPending(env);
  const tasks = COL_IDS.map((col) => ({ t: 'list', col, limit }));
  await env.EPI_KV.put(K.pending, JSON.stringify([...tasks, ...pending.filter((t) => t.t === 'detail')]));
  idx.meta.lastScan = today;
  await env.EPI_KV.put(K.idx, JSON.stringify(idx));
  return { started: true, queued: COL_IDS.length, limit };
}

/* ------------------------------------------------------------ 静态看板外壳 */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function boardShell() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>湖州环评公示看板</title>
<style>
:root{--bg:#f5f7fa;--card:#fff;--line:#e6e9ef;--txt:#1f2430;--sub:#6b7280;--brand:#1f7a4d;--brand2:#e8f5ee;--warn:#d4380d;--warn-bg:#fff2e8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
header{background:linear-gradient(135deg,#0f5132,#1f7a4d);color:#fff;padding:22px 28px}
header h1{margin:0;font-size:20px}
header p{margin:6px 0 0;opacity:.85;font-size:13px}
.wrap{max-width:1200px;margin:0 auto;padding:18px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.stat b{display:block;font-size:24px;color:var(--brand)}
.stat span{color:var(--sub);font-size:12px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}
input,select{padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:#fff;font-size:13px}
input{flex:1;min-width:220px}
.chip{padding:6px 12px;border:1px solid var(--line);background:#fff;border-radius:999px;cursor:pointer;font-size:12px;color:var(--sub)}
.chip.on{background:var(--brand);border-color:var(--brand);color:#fff}
.group{margin-bottom:22px}
.group h2{font-size:15px;margin:0 0 10px;padding-left:9px;border-left:3px solid var(--brand)}
.item{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:8px}
.item.new{border-color:#ffa39e;background:var(--warn-bg)}
.row1{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.tag{font-size:11px;padding:2px 8px;border-radius:6px;background:var(--brand2);color:var(--brand)}
.tag.unit{background:#eef2ff;color:#3949ab}
.tag.date{background:#f1f3f5;color:#495057}
.badge-new{font-size:11px;color:#fff;background:var(--warn);padding:2px 8px;border-radius:6px}
.item a{color:var(--txt);text-decoration:none;font-weight:500}
.item a:hover{color:var(--brand)}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12.5px}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{background:#fafbfc;font-weight:600;white-space:nowrap}
.summary{color:var(--sub);font-size:12.5px;margin-top:6px}
.empty{text-align:center;color:var(--sub);padding:40px 0}
.monthbar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
footer{text-align:center;color:var(--sub);font-size:12px;padding:20px 0 34px}
</style>
</head>
<body>
<header>
  <h1>湖州市生态环境局 · 环评公示监测看板</h1>
  <p id="sub">加载中…</p>
</header>
<div class="wrap">
  <div class="stats">
    <div class="stat"><b id="s1">-</b><span>本轮新增公告</span></div>
    <div class="stat"><b id="s2">-</b><span>已加载公告</span></div>
    <div class="stat"><b id="s3">-</b><span>涉及建设项目数</span></div>
    <div class="stat"><b id="s4">-</b><span>覆盖发布单位</span></div>
  </div>
  <div class="bar">
    <input id="q" placeholder="搜索项目名称、建设单位、地点、关键字…">
    <select id="unitSel"><option value="">全部单位</option></select>
    <select id="typeSel"><option value="">全部类型</option></select>
    <span class="chip" id="newOnly">只看今日新增</span>
  </div>
  <div class="monthbar" id="months"></div>
  <div id="list"><div class="empty">加载中…</div></div>
</div>
<footer>Cloudflare Worker + KV（免费计划）· 数据以官网原文为准</footer>
<script>
let DATA = [], onlyNew = false;
const NEW_WINDOW_H = 36;   // 采集时间在 36 小时内的算「本轮新增」
const q = document.getElementById('q'), unitSel = document.getElementById('unitSel'),
      typeSel = document.getElementById('typeSel'), list = document.getElementById('list'),
      monthsBox = document.getElementById('months');
let newIds = [];

// fetched_at 是北京时间字符串，按 UTC 解析后减 8 小时得到真实时间戳
function isNewItem(d) {
  if (!d.fetched_at) return false;
  const t = Date.parse(d.fetched_at.replace(' ', 'T') + 'Z') - 8 * 3600 * 1000;
  return Number.isFinite(t) && (Date.now() - t) < NEW_WINDOW_H * 3600 * 1000;
}

async function load(viaClick) {
  const params = new URLSearchParams(location.search);
  let ms = (params.get('months') || '').split(',').filter(Boolean);
  if (!ms.length) {
    const now = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const ym = now.slice(0, 7);
    const prev = new Date(new Date(now).getTime() - 32 * 864e5).toISOString().slice(0, 7);
    ms = [ym, prev];
  }
  if (viaClick) {
    location.search = '?months=' + ms.join(',');
    return;
  }
  try {
    const r = await fetch('/api/items?months=' + ms.join(','));
    const j = await r.json();
    DATA = (j.items || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    newIds = DATA.filter(isNewItem).map(d => d.art_id);
    if (j.months) {
      monthsBox.innerHTML = j.months.map(m =>
        '<span class="chip' + (ms.includes(m) ? ' on' : '') + '" data-m="' + m + '">' + m + '</span>').join('');
      monthsBox.querySelectorAll('.chip').forEach(c => c.onclick = () => {
        const set = new Set(ms);
        set.has(c.dataset.m) ? set.delete(c.dataset.m) : set.add(c.dataset.m);
        location.search = '?months=' + [...set].sort().reverse().join(',');
      });
    }
    document.getElementById('sub').textContent =
      '数据来源：湖州市生态环境局官网「行政审批（许可）公示」| 已加载 ' + DATA.length + ' 条，其中本轮新增 ' +
      newIds.length + ' 条 | 最近采集 ' + (j.updated || '');
    render();
  } catch (e) {
    list.innerHTML = '<div class="empty">数据加载失败：' + e + '</div>';
  }
}

document.getElementById('newOnly').onclick = (ev) => {
  onlyNew = !onlyNew;
  ev.target.classList.toggle('on', onlyNew);
  render();
};
q.oninput = unitSel.onchange = typeSel.onchange = render;

function projTable(ps) {
  if (!ps || !ps.length) return '';
  let h = '<table><tr><th>#</th><th>项目名称</th><th>建设地点</th><th>建设单位</th><th>环评机构</th><th>受理日期</th><th>附件</th></tr>';
  ps.forEach((p, i) => {
    const files = (p.files || []).map(u => '<a href="' + u + '" target="_blank" rel="noopener">下载</a>').join(' ') || '-';
    h += '<tr><td>' + (i + 1) + '</td><td>' + (p.name || '-') + '</td><td>' + (p.loc || '-') + '</td><td>' +
      (p.org || '-') + '</td><td>' + (p.inst || '-') + '</td><td>' + (p.date || '-') + '</td><td>' + files + '</td></tr>';
  });
  return h + '</table>';
}

function render() {
  const kw = q.value.trim().toLowerCase();
  const unit = unitSel.value, type = typeSel.value;
  const rows = DATA.filter(d => {
    if (onlyNew && !newIds.includes(d.art_id)) return false;
    if (unit && d.unit !== unit) return false;
    if (type && d.type !== type) return false;
    if (kw) {
      const hay = (d.title + ' ' + d.date + ' ' + d.unit + ' ' + d.area + ' ' +
        (d.projects || []).map(p => Object.values(p).join(' ')).join(' ')).toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  const units = [...new Set(DATA.map(d => d.unit))].sort();
  const types = [...new Set(DATA.map(d => d.type))].sort();
  unitSel.innerHTML = '<option value="">全部单位</option>' + units.map(u => '<option>' + u + '</option>').join('');
  typeSel.innerHTML = '<option value="">全部类型</option>' + types.map(t => '<option>' + t + '</option>').join('');
  unitSel.value = unit; typeSel.value = type;

  document.getElementById('s1').textContent = newIds.length;
  document.getElementById('s2').textContent = rows.length;
  document.getElementById('s3').textContent = rows.reduce((n, d) => n + (d.projects || []).length, 0);
  document.getElementById('s4').textContent = units.length;

  if (!rows.length) { list.innerHTML = '<div class="empty">没有符合条件的公示</div>'; return; }
  const groups = {};
  rows.forEach(d => (groups[d.unit] = groups[d.unit] || []).push(d));
  let html = '';
  Object.keys(groups).sort().forEach(u => {
    html += '<div class="group"><h2>' + u + '（' + groups[u].length + '）</h2>';
    groups[u].forEach(d => {
      const isNew = newIds.includes(d.art_id);
      html += '<div class="item' + (isNew ? ' new' : '') + '"><div class="row1">' +
        '<span class="tag date">' + (d.date || '未标注') + '</span>' +
        '<span class="tag">' + d.type + '</span>' +
        '<span class="tag unit">' + d.area + '</span>' +
        (isNew ? '<span class="badge-new">NEW</span>' : '') +
        '<a href="' + d.url + '" target="_blank" rel="noopener">' + d.title + '</a></div>' +
        projTable(d.projects) + '</div>';
    });
    html += '</div>';
  });
  list.innerHTML = html;
}

load();
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------ HTTP */

/* 具名导出，方便本地用 Node 直接单测 / 压测 CPU */
export { fetchColumn, fetchDetail, parseProjects, startCycle, runBatch, runOneTask, boardShell };

const jsonRes = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const authorized = (req, env) =>
  !!env.ADMIN_TOKEN && req.headers.get('X-Admin-Token') === env.ADMIN_TOKEN;

async function dispatch(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path === '/' || path === '/board') {
      return new Response(boardShell(), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (path === '/api/items') {
      const idx = await getIdx(env);
      const want = (url.searchParams.get('months') || '').split(',').filter(Boolean);
      const months = want.length ? want.slice(0, 6) : idx.months.slice(0, 3);
      const parts = await Promise.all(
        months.map((m) => env.EPI_KV.get(K.month(m), 'text').then((t) => t || '[]'))
      );
      // 直接拼字符串返回，不 parse 再 stringify，省下大量 CPU
      let merged = '[';
      let first = true;
      for (const p of parts) {
        const inner = p.trim().slice(1, -1);
        if (!inner) continue;
        if (!first) merged += ',';
        merged += inner;
        first = false;
      }
      merged += ']';
      return new Response('{"months":' + JSON.stringify(idx.months) +
        ',"updated":' + JSON.stringify(idx.meta?.lastTaskAt ?? '') + ',"items":' + merged + '}', {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (path === '/api/status') {
      const [pending, idx] = await Promise.all([getPending(env), getIdx(env)]);
      const months = idx.months.slice(0, 12);
      const counts = Object.fromEntries(await Promise.all(
        months.map(async (m) => {
          const v = await env.EPI_KV.get(K.month(m), 'json');
          return [m, Array.isArray(v) ? v.length : 0];
        })
      ));
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return jsonRes({ pendingTasks: pending.length, totalItems: total, counts, meta: idx.meta });
    }

    if ((path === '/api/start' || path === '/api/step') && request.method === 'POST') {
      if (!authorized(request, env)) return jsonRes({ ok: false, error: 'unauthorized' }, 401);
      const n = Number(url.searchParams.get('n')) || Number(env.STEP_SIZE) || 1;
      const started = path === '/api/start' ? await startCycle(env, { force: true }) : null;
      // 扫描任务本身很轻，先跑掉再按预算解析详情
      let scan = [];
      for (let i = 0; i < 4; i++) {
        const pending = await getPending(env);
        if (!pending.length || pending[0].t !== 'list') break;
        scan.push(await runOneTask(env));
      }
      const steps = await runBatch(env, n);
      const pending = await getPending(env);
      return jsonRes({ ok: true, started, scanSteps: scan.length, steps, remaining: pending.length });
    }

    return jsonRes({ ok: false, error: 'not found' }, 404);
  } catch (e) {
    return jsonRes({ ok: false, error: String(e) }, 500);
  }
}

export default {
  /**
   * cron 每分钟来一次（见 wrangler.toml）。
   * 单次 CPU 预算 10ms，所以这里只做两件小事：
   *   1. 每天第一次进来时，把 16 个栏目作为 list 任务写进队列
   *   2. 按 STEP_SIZE 消化若干任务
   * 队列空了就直接返回，什么都不做。
   */
  async scheduled(controller, env) {
    const idx = await getIdx(env);
    if (idx.meta.lastScan !== cstDate()) {
      await startCycle(env);
    }
    await runBatch(env, Number(env.STEP_SIZE) || 1);
  },

  async fetch(request, env) {
    return dispatch(request, env);
  },
};
