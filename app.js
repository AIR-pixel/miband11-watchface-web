import { decodeGif } from './src/core/gif.js';
import { coverRGBA } from './src/core/image.js';
import { quantize } from './src/core/quantize.js';
import { encodePNG } from './src/core/png.js';
import { PREVIEW_W, PREVIEW_H } from './src/core/facebin.js';
import { planAod, estimateAodBytes, aodRecCount, parseColor } from './src/core/aod.js';
import { planFrames, planUniform } from './src/core/build.js';
import { probeVideo, extractFrames, firstFrame, releaseVideo } from './src/core/video.js';
import { DEMOS, DEMO_COUNT, DEMO_PERIOD_MS, renderDemoFrames } from './src/core/demo.js';

const $ = (id) => document.getElementById(id);
const canvas = $('preview');
const ctx = canvas.getContext('2d');

/** 状态。walls 是唯一事实源（顺序 = 表盘里的壁纸页序）。 */
const state = {
  walls: [],          // [{ name, kind:'gif'|'video', bytes?, frames?, poster?, video?, plan }]
  wallIdx: 0,
  level: 'balanced',
  view: 'main',
  estimate: null,
  building: false,
};

const COLORS = { high: 256, balanced: 256, small: 128, tiny: 64 };
const FIXED_BYTES = 440972 + 12 + 400; // 预览位图 + 容器骨架（估算用，实际以构建为准）

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ───────────── 内置示例（首屏就有动效，不依赖用户素材） ───────────── */

let demoIdx = 0;

function makeDemoWall(id) {
  const frames = renderDemoFrames(id, PREVIEW_W, PREVIEW_H);
  const label = (DEMOS.find((d) => d.id === id) || DEMOS[0]).name;
  return {
    name: label,
    kind: 'demo',
    demoId: id,
    frames,
    plan: {
      count: frames.length,
      periodMs: DEMO_PERIOD_MS,
      durationMs: frames.length * DEMO_PERIOD_MS,
      indices: frames.map((_, i) => i),
    },
  };
}

/** 只在没有任何真实素材时才挂示例，且只有一个 */
function ensureDemo() {
  if (state.walls.some((w) => w.kind !== 'demo')) return;
  const id = DEMOS[demoIdx % DEMOS.length].id;
  state.walls = [makeDemoWall(id)];
  state.wallIdx = 0;
}

function nextDemo() {
  demoIdx += 1;
  state.walls = state.walls.filter((w) => w.kind !== 'demo');
  state.walls.unshift(makeDemoWall(DEMOS[demoIdx % DEMOS.length].id));
  state.wallIdx = 0;
  state.view = 'main';
  [...$('viewTabs').children].forEach((b) => b.classList.toggle('on', b.dataset.v === 'main'));
  recomputePlans();
  scheduleEstimate();
  syncBuildBtn();
}

const hasRealWall = () => state.walls.some((w) => w.kind !== 'demo');

/* ───────────── 素材载入 ───────────── */

const isGif = (f) => /gif$/i.test(f.name) || f.type === 'image/gif';
const isVideo = (f) => /^(video)\//.test(f.type) || /\.(mp4|webm|mov|m4v)$/i.test(f.name);

async function loadFiles(files) {
  const list = [...files].filter(Boolean);
  if (!list.length) return;
  // 真实素材进来，示例自动让位（不然会混进生成结果）
  const hadDemo = state.walls.some((w) => w.kind === 'demo');
  if (hadDemo) { state.walls = []; state.wallIdx = 0; }
  for (const file of list) {
    try {
      if (isGif(file)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const gif = decodeGif(bytes);
        if (!gif.frames.length) throw new Error('没有解出帧');
        state.walls.push({
          name: file.name, kind: 'gif', bytes,
          gif,
          frames: gif.frames.map((f) => coverRGBA(f.rgba, gif.width, gif.height, PREVIEW_W, PREVIEW_H)),
          plan: null,
        });
      } else if (isVideo(file)) {
        setHint(`读取「${file.name}」…`);
        const video = await probeVideo(file);
        const poster = await firstFrame(video, PREVIEW_W, PREVIEW_H);
        state.walls.push({ name: file.name, kind: 'video', video, poster, plan: null });
      } else {
        setHint(`「${file.name}」不是 GIF 或视频。`);
        continue;
      }
    } catch (e) {
      setHint(`「${file.name}」读不了：${e.message}`);
    }
  }
  if (state.wallIdx >= state.walls.length) state.wallIdx = 0;
  ensureDemo();               // 一个都没读进来（或全失败）时把示例放回去
  recomputePlans();
  startPreview();
  scheduleEstimate();
  syncBuildBtn();
}

function renderWallList() {
  const box = $('wallList');
  box.hidden = state.walls.length === 0;
  box.innerHTML = state.walls.map((w, i) => `
    <div class="wall${i === state.wallIdx ? ' on' : ''}" data-i="${i}">
      <span class="idx">${i + 1}</span>
      <span class="nm">${escapeHtml(w.name)}${w.kind === 'video' ? ' <i class="tag">视频</i>' : ''}${w.kind === 'demo' ? ' <i class="tag demo">示例</i>' : ''}</span>
      <span class="cnt">${w.plan ? w.plan.count : 0} 帧</span>
      ${w.kind === 'demo' ? '<span class="swp" data-swap="1" title="换一个示例">换</span>' : ''}
      ${w.kind === 'demo' ? '' : `<span class="rm" data-rm="${i}">✕</span>`}
    </div>`).join('');
  const total = state.walls.reduce((a, w) => a + (w.plan ? w.plan.count : 0), 0);
  $('srcInfo').textContent = state.walls.length
    ? (hasRealWall()
      ? `${state.walls.length} 张壁纸 · 共 ${total} 帧`
      : `示例预览 · 共 ${total} 帧`)
    : '等待素材';
}

function recomputePlans() {
  const fps = Number($('fps').value);
  const maxFrames = Number($('maxFrames').value);
  for (const w of state.walls) {
    if (w.kind === 'demo') continue;      // 示例帧数固定，不跟帧率/上限走
    if (w.kind === 'video') {
      w.plan = planUniform(w.video.durationMs, fps, maxFrames);
    } else {
      const p = planFrames(w.gif.frames.map((f) => f.delayMs), fps, maxFrames);
      w.plan = { count: p.indices.length, periodMs: p.periodMs, indices: p.indices,
        durationMs: p.durationMs };
    }
  }
  renderWallList();
  if (!state.walls.length) return;
  if (!hasRealWall()) {
    setHint('这是内置示例，用来演示表盘在手表上的样子。拖入自己的 GIF 或视频就能替换掉它。');
    return;
  }
  const total = state.walls.reduce((a, w) => a + w.plan.count, 0);
  const per = state.walls.filter((w) => w.kind !== 'demo').map((w) => w.plan.count).join(' + ');
  const vids = state.walls.filter((w) => w.kind === 'video').length;
  const note = vids ? `视频在点「生成」时按 ${total} 个时间点抽帧。` : '';
  const warn = total > 320 ? ' 帧数偏多，生成会慢，也吃内存。' : '';
  setHint(state.walls.length > 1
    ? `每张壁纸 ${per} 帧，共 ${total} 帧 @ ${(1000 / state.walls[0].plan.periodMs).toFixed(1)}fps。多壁纸默认开启短按切换。${note}${warn}`
    : `保留 ${total} 帧 @ ${(1000 / state.walls[0].plan.periodMs).toFixed(1)}fps，原素材 ${(state.walls[0].plan.durationMs / 1000).toFixed(2)}s。${note}${warn}`);
}

/* ───────────── 预览 ───────────── */

let rafId = 0;
function startPreview() {
  cancelAnimationFrame(rafId);
  const step = () => {
    if (state.view === 'aod') {
      drawAod();
    } else {
      const w = state.walls[state.wallIdx];
      if (w && w.plan && w.plan.count) {
        if (w.kind === 'video') {
          // 视频只在生成时抽帧，预览给首帧 + 一句说明
          drawFrame(w.poster, '视频 · 点生成时抽帧');
        } else {
          const i = Math.floor(performance.now() / w.plan.periodMs) % w.plan.count;
          drawFrame(w.frames[w.plan.indices[i]]);
        }
      }
    }
    rafId = requestAnimationFrame(step);
  };
  step();
}

const imgBuf = new ImageData(PREVIEW_W, PREVIEW_H);
function drawFrame(rgba, note) {
  if (!rgba) return;
  imgBuf.data.set(rgba);
  ctx.putImageData(imgBuf, 0, 0);
  if ($('showTime').checked) {
    const size = Number($('timeSize').value);
    const y = Number($('timeOfs').value) + size;
    const now = new Date();
    const txt = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    ctx.font = `300 ${size}px system-ui, -apple-system, "PingFang SC"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    // 柔和的暗色投影：表盘背景可能是亮的，纯白字没有这层会糊在画面里
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 8;
    ctx.fillText(txt, PREVIEW_W / 2, y);
    ctx.shadowBlur = 0;
  }
  if ($('showDate').checked) {
    const now = new Date();
    const txt = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    ctx.font = '400 16px system-ui, -apple-system, "PingFang SC"';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#eee';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 6;
    ctx.fillText(txt, PREVIEW_W / 2, 86 + 16);
    ctx.shadowBlur = 0;
  }
  if (note) {
    ctx.font = '400 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(note, PREVIEW_W / 2, PREVIEW_H - 12);
  }
}

/* ───────────── 息屏预览 ───────────── */

function aodCfg() {
  return {
    enabled: $('aodOn').checked,
    timeMode: $('aodMode').value,
    timeY: Number($('aodTimeY').value),
    dateY: Number($('aodDateY').value),
    color: $('aodColor').value || '#FFFFFF',
  };
}

function drawAod() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
  const cfg = aodCfg();
  if (!cfg.enabled) {
    ctx.fillStyle = '#3a414d';
    ctx.font = '400 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('未启用息屏显示', PREVIEW_W / 2, PREVIEW_H / 2);
    return;
  }
  const [r, g, b] = parseColor(cfg.color);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  const now = new Date();
  const values = {
    aod_hour: String(now.getHours()).padStart(2, '0'),
    aod_min: String(now.getMinutes()).padStart(2, '0'),
    aod_month: String(now.getMonth() + 1).padStart(2, '0'),
    aod_day: String(now.getDate()).padStart(2, '0'),
  };
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const w of planAod(cfg)) {
    if (w.kind === 32) {
      const txt = values[w.name] || '';
      ctx.font = `600 ${Math.round(w.digitH * 0.92)}px "Helvetica Neue", Arial, sans-serif`;
      for (let i = 0; i < txt.length; i++) {
        ctx.fillText(txt[i], w.x + w.digitW * (i + 0.5), w.y + w.digitH / 2);
      }
    } else if (w.name.includes('colon')) {
      const rad = Math.max(1, Math.round(w.w * 0.28));
      for (const fy of [0.34, 0.68]) {
        ctx.beginPath();
        ctx.arc(w.x + w.w / 2, w.y + w.h * fy, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/* ───────────── 体积估算 ───────────── */

let estimateTimer = 0;
function scheduleEstimate() {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(estimate, 240);
}

async function estimate() {
  if (!state.walls.length) return;
  const colors = COLORS[state.level] || 256;
  // 用第一张壁纸的首帧真编一遍来估每帧字节（PNG 体积取决于画面复杂度）
  const first = state.walls[0];
  const sample = first.kind === 'video' ? first.poster : first.frames[0];
  if (!sample) return;
  const { indices, palette } = quantize(sample, colors, false);
  const png = await encodePNG(indices, palette, PREVIEW_W, PREVIEW_H);
  const frames = state.walls.reduce((a, w) => a + (w.plan ? w.plan.count : 0), 0);
  const aod = aodCfg();
  const aodBytes = aod.enabled
    ? estimateAodBytes(aod) + aodRecCount(planAod(aod)) * 16 // 描述块每条 16 B
    : 0;
  const imageBytes = png.length * frames;
  const total = FIXED_BYTES + imageBytes + aodBytes;
  state.estimate = { perFrame: png.length, frames, total, aodBytes };

  const kb = (n) => (n / 1024).toFixed(0);
  const pct = (n) => Math.min(100, (n / total) * 100);
  // 只有示例时，这个数字是「假如把你看到的这段做成表盘会有多大」，别让人以为已经能生成
  $('budgetLabel').textContent = hasRealWall() ? '体积预算' : '体积预算（按当前示例估算）';
  $('budgetTotal').textContent = `≈ ${kb(total)} KB`;
  $('barFixed').style.width = `${pct(FIXED_BYTES)}%`;
  $('barFrames').style.width = `${pct(imageBytes)}%`;
  $('barAod').style.width = `${pct(aodBytes)}%`;
  $('barAod').hidden = !aod.enabled;
  $('fixedKb').textContent = kb(FIXED_BYTES);
  $('framesKb').textContent = kb(imageBytes);
  $('aodRow').hidden = !aod.enabled;
  $('aodKb').textContent = kb(aodBytes);
  $('aodCost').textContent = aod.enabled ? `+ ${kb(aodBytes)} KB` : '不启用';
}

/* ───────────── 生成 ───────────── */

let worker = null;
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./src/worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        $('bar').style.width = `${(m.ratio * 100).toFixed(0)}%`;
        setHint(m.msg);
      } else if (m.type === 'done') {
        finishBuild(m);
      } else if (m.type === 'error') {
        setHint(`生成失败：${m.message}`);
        setBuilding(false);
      }
    };
    // Worker 里未捕获的异常不会走 onmessage，只会触发这里。不接的话界面会永远卡在
    // 「生成中…」，按钮也一直是禁用态。顺手把这个 Worker 丢掉，下次点生成重建一个。
    worker.onerror = (e) => {
      setHint(`生成失败：${e.message || '生成脚本出错'}`);
      setBuilding(false);
      try { worker.terminate(); } catch { /* 已经没了就算了 */ }
      worker = null;
      e.preventDefault();
    };
  }
  return worker;
}

async function build() {
  if (state.building) return;
  const real = state.walls.filter((w) => w.kind !== 'demo');
  if (!real.length) {
    setHint('示例只是演示，不能生成 —— 先拖入自己的 GIF 或视频。');
    return;
  }
  setBuilding(true);
  $('bar').style.width = '2%';

  // 视频帧必须在主线程抽（Worker 里没有 <video>），抽完按 Transferable 交给 Worker。
  // 每点一次生成都重新抽 —— 帧 buffer 被 transfer 走之后就 detach 了，不能留着重用。
  const sources = [];
  const transfer = [];
  const totalFrames = real.reduce((a, w) => a + w.plan.count, 0);
  let extracted = 0;
  try {
    for (const w of real) {
      if (w.kind === 'gif') {
        sources.push({ kind: 'gif', bytes: w.bytes });
        continue;
      }
      const frames = await extractFrames(w.video, w.plan.times, PREVIEW_W, PREVIEW_H, (d, t) => {
        const ratio = 0.02 + 0.12 * ((extracted + d) / totalFrames);
        $('bar').style.width = `${(ratio * 100).toFixed(0)}%`;
        setHint(`从「${w.name}」抽帧 ${d}/${t}…`);
      });
      extracted += frames.length;
      for (const f of frames) transfer.push(f.buffer);
      sources.push({ kind: 'frames', frames, periodMs: w.plan.periodMs });
    }
  } catch (e) {
    setHint(`抽帧失败：${e.message}`);
    setBuilding(false);
    return;
  }

  getWorker().postMessage({
    type: 'build',
    sources,
    opts: {
      fps: Number($('fps').value),
      maxFrames: Number($('maxFrames').value),
      level: state.level,
      showTime: $('showTime').checked,
      showDate: $('showDate').checked,
      timeSize: Number($('timeSize').value),
      timeOfs: [0, Number($('timeOfs').value)],
      tap: $('tapAnim').checked ? 'anim' : 'none',
      aod: aodCfg(),
      // 原文照传：定长 ASCII 字段的转换与文件名清洗都在 core 里做（可单测）
      title: $('title').value.trim() || 'MyFace',
      faceId: $('faceId').value,
    },
  }, transfer);
}

function finishBuild({ face, faceName, stats }) {
  const blob = new Blob([face], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = faceName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  setBuilding(false);
  $('bar').style.width = '100%';
  const wallPart = stats.walls > 1 ? `${stats.walls} 张壁纸 / ` : '';
  const aodPart = stats.hasAod ? ' · 含息屏' : '';
  setHint(`已生成 ${faceName} · ${wallPart}${stats.frames} 帧 @ ${stats.fps}fps${aodPart} · `
    + `合计 ${(stats.bytes / 1024).toFixed(0)} KB（帧数据 ${(stats.imageBytes / 1024).toFixed(0)} KB）`);
}

function setBuilding(v) {
  state.building = v;
  const b = $('build');
  if (v) { b.disabled = true; b.textContent = '生成中…'; return; }
  syncBuildBtn();
}

/** 生成按钮的状态：只有示例时禁用，并直说「先拖入素材」 */
function syncBuildBtn() {
  const b = $('build');
  if (!b) return;
  const real = hasRealWall();
  b.disabled = state.building || !real;
  if (!state.building) b.textContent = real ? '生成 .face' : '先拖入素材';
}

function setHint(t) { $('hint').textContent = t; }

/* ───────────── 事件 ───────────── */

$('drop').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
['dragenter', 'dragover'].forEach((ev) =>
  $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('over'); }));
$('drop').addEventListener('drop', (e) => loadFiles(e.dataTransfer.files));

$('wallList').addEventListener('click', (e) => {
  if (e.target.closest('[data-swap]')) { nextDemo(); return; }
  const rm = e.target.closest('[data-rm]');
  if (rm) {
    const i = Number(rm.dataset.rm);
    const [gone] = state.walls.splice(i, 1);
    if (gone && gone.kind === 'video') releaseVideo(gone.video);
    if (i < state.wallIdx) state.wallIdx -= 1;   // 删掉前面的行，选中项跟着前移，别跳一格
    if (state.wallIdx >= state.walls.length) state.wallIdx = Math.max(0, state.walls.length - 1);
    ensureDemo();              // 删光了就把示例放回来，别留个空预览
    recomputePlans();          // 重算帧数与提示，否则删页后底部还写着旧帧数
    scheduleEstimate();
    syncBuildBtn();
    return;
  }
  const row = e.target.closest('.wall');
  if (!row) return;
  state.wallIdx = Number(row.dataset.i);
  state.view = 'main';
  [...$('viewTabs').children].forEach((b) => b.classList.toggle('on', b.dataset.v === 'main'));
  renderWallList();
});

$('level').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  [...$('level').children].forEach((b) => b.classList.toggle('on', b === btn));
  state.level = btn.dataset.v;
  scheduleEstimate();
});

$('fps').addEventListener('change', () => { recomputePlans(); scheduleEstimate(); });
$('maxFrames').addEventListener('change', () => { recomputePlans(); scheduleEstimate(); });

['timeSize', 'timeOfs'].forEach((id) => {
  const out = id === 'timeOfs' ? $('timeOfsOut') : null;
  $(id).addEventListener('input', () => { if (out) out.textContent = $(id).value; });
});

$('build').addEventListener('click', build);

$('aodOn').addEventListener('change', () => {
  $('aodBody').hidden = !$('aodOn').checked;
  if ($('aodOn').checked) {
    state.view = 'aod';
    [...$('viewTabs').children].forEach((b) => b.classList.toggle('on', b.dataset.v === 'aod'));
  }
  scheduleEstimate();
});
['aodMode', 'aodColor'].forEach((id) => $(id).addEventListener('input', scheduleEstimate));
['aodTimeY', 'aodDateY'].forEach((id) => {
  const out = $(id + 'Out');
  $(id).addEventListener('input', () => { out.textContent = $(id).value; });
});

$('viewTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.view = btn.dataset.v;
  [...$('viewTabs').children].forEach((b) => b.classList.toggle('on', b === btn));
});

$('aodBody').hidden = true;
$('wallList').hidden = true;

// 首屏：先铺一层黑，再挂上内置示例 —— 一进来就看得到表盘在动，
// 不用先找素材才明白这工具干什么
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
ensureDemo();
recomputePlans();
startPreview();
scheduleEstimate();
syncBuildBtn();
