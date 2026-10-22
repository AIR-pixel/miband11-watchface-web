/**
 * AOD 链路冒烟：在 Node 里没有 OffscreenCanvas，所以注入一个确定性的字形遮罩，
 * 验证的是**容器字节**（描述块分组、偏移、payload 长度），不是字形好看不好看。
 *
 *   node tests/aod_build.mjs <in.gif> <out.face> [--mode time|both]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFaceFromGif } from '../src/core/build.js';
import { unfoldAod } from './_aod_check.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const args = process.argv.slice(2);
const gifPath = args[0] || here('./golden-src/a.gif');
const outPath = args[1] || here('./out/aod_build.face');
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'both';

/** 确定性遮罩：把字符码映射成一圈渐变的环，纯粹为了让不同数字的字节不同 */
function fakeMask(ch, w, h) {
  const mask = new Uint8Array(w * h);
  const seed = ch.charCodeAt(0) % 10;
  const cx = w / 2, cy = h / 2;
  const rOuter = Math.min(w, h) * 0.42;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const ring = Math.abs(d - rOuter * (0.55 + seed * 0.04));
      const a = Math.max(0, 1 - ring / (rOuter * 0.35));
      mask[y * w + x] = Math.round(a * 255);
    }
  }
  return mask;
}

const gifBytes = new Uint8Array(readFileSync(gifPath));
const common = { gifBytes, fps: 8, maxFrames: 48, level: 'tiny', renderMask: fakeMask };

const plain = await buildFaceFromGif({ ...common, title: 'NoAod', faceId: '2000000001' });
const withAod = await buildFaceFromGif({
  ...common,
  title: 'WithAod',
  faceId: '2000000002',
  aod: { enabled: true, timeMode: mode, color: '#FFFFFF' },
});

writeFileSync(outPath, withAod.face);
const delta = withAod.face.length - plain.face.length;

const recs = unfoldAod(withAod.face);
const tags = recs.map((r) => '0x' + r.tag.toString(16).padStart(4, '0'));

// ---- 自检：描述块分组顺序、偏移是否落在素材区、体积增量是否合理 ----
const fail = [];
if (!recs.length) fail.push('没有 AOD 描述记录');
if (tags[0] !== '0x0000') fail.push(`第一条记录应是锚点 0x0000，实际 ${tags[0]}`);
if (!tags.includes('0x0200')) fail.push('没有位图记录 0x0200');
// 描述块内的分组顺序是固定的：锚 → 位图 → 数组 → 小件（实测，别改）
const RANK = { '0x0000': 0, '0x0200': 1, '0x0300': 2, '0x0700': 3 };
for (let i = 1; i < tags.length; i++) {
  const a = RANK[tags[i - 1]], b = RANK[tags[i]];
  if (a === undefined || b === undefined) { fail.push(`未知 tag ${tags[i]}`); break; }
  if (b < a) { fail.push(`描述块顺序乱了：${tags[i - 1]} 之后出现 ${tags[i]}`); break; }
}
if (delta <= 0) fail.push('开了 AOD 体积反而没变大');
const est = withAod.stats.aodBytes;
if (est > 0 && Math.abs(delta - est) / est > 0.35) {
  fail.push(`实际增量 ${delta} 与估算 ${est} 差超过 35%`);
}

console.log(JSON.stringify({
  mode,
  src: gifPath,
  frames: withAod.stats.frames,
  plainBytes: plain.face.length,
  aodBytes: withAod.face.length,
  deltaFromContainer: delta,
  estimatedAodBytes: est,
  recCount: withAod.stats.recs,
  recTags: tags,
  out: outPath,
  fail,
}, null, 2));
process.exit(fail.length ? 1 : 0);
