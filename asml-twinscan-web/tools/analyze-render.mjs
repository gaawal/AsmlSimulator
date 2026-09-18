/**
 * 渲染稳定性 / 清晰度分析工具。
 *
 * 用法: node tools/analyze-render.mjs [标签]
 * 需要先跑起 `npm run dev`（127.0.0.1:5173）。
 *
 * 方法：把流水线推进到曝光中并暂停，此时相机静止、仿真时间冻结，
 * 场景是一张“静止画面”。此时连续截图：
 *   - 帧间差异（temporal）不为 0 说明渲染本身在抖（抖动 / 时间不稳定）；
 *   - 拉普拉斯能量（sharpness）衡量清晰度，越高越锐利。
 * 逐个画质档位测量，输出表格。
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const label = process.argv[2] ?? '';
const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(localChrome) ? localChrome : undefined,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
page.on('pageerror', error => console.log('[pageerror]', error.message));
page.on('console', msg => { if (msg.type() === 'error') console.log('[console]', msg.text()); });

await page.goto('http://127.0.0.1:5173/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__twinscan?.ready === true, null, { timeout: 120000 });

// 冻结场景：进入曝光中，然后不再推进仿真时间。
// 刷新后默认是光刻机界面，设计面板要显式打开。
await page.evaluate(() => window.__twinscan.action('designs'));
await page.locator('.design-card').first().click();
await page.waitForFunction(() => window.__twinscan.snapshot().state !== 'ready', null, { timeout: 20000 });
await page.evaluate(() => {
  for (let i = 0; i < 400; i++) {
    const state = window.__twinscan.advance(0.25);
    if (state.exposing_stage && state.exposure_progress?.die_index >= 1) return;
    if (state.state === 'done') return;
  }
});
await page.evaluate(() => window.__twinscan.action('follow', false));
await page.evaluate(() => window.__twinscan.action('camera', 'optics'));
await page.waitForTimeout(1600);

/** 在页面内取 N 帧并计算指标（避免把像素数据搬出页面）。 */
const measure = (frames, sharpnessFrame) => page.evaluate(async ({ frames, sharpnessFrame }) => {
  const src = document.querySelector('canvas');
  const flat = document.createElement('canvas');
  flat.width = src.width;
  flat.height = src.height;
  const ctx = flat.getContext('2d', { willReadFrequently: true });
  const grab = async () => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    ctx.drawImage(src, 0, 0);
    return ctx.getImageData(0, 0, flat.width, flat.height).data;
  };
  const shots = [];
  for (let i = 0; i < frames; i++) shots.push(await grab());

  // 帧间差异：亮度绝对差，统计均值与“变化超过 2/255 的像素占比”。
  let sum = 0, peak = 0, changed = 0, samples = 0;
  for (let f = 1; f < shots.length; f++) {
    const a = shots[f - 1], b = shots[f];
    for (let p = 0; p < a.length; p += 4) {
      const d = Math.abs(a[p] * 0.299 + a[p + 1] * 0.587 + a[p + 2] * 0.114
        - (b[p] * 0.299 + b[p + 1] * 0.587 + b[p + 2] * 0.114));
      sum += d; peak = Math.max(peak, d);
      if (d > 2) changed++;
      samples++;
    }
  }

  // 清晰度：拉普拉斯能量的均值（取一帧）。
  const px = shots[Math.min(sharpnessFrame, shots.length - 1)];
  const w = flat.width, h = flat.height;
  const luma = (data, x, y) => {
    const i = (y * w + x) * 4;
    return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  };
  let lap = 0, lapMax = 0, lapCount = 0;
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
    const v = Math.abs(4 * luma(px, x, y) - luma(px, x - 1, y) - luma(px, x + 1, y) - luma(px, x, y - 1) - luma(px, x, y + 1));
    lap += v; lapMax = Math.max(lapMax, v); lapCount++;
  }
  return {
    temporalMean: sum / samples, temporalPeak: peak,
    temporalChangedPct: (changed / samples) * 100,
    sharpness: lap / lapCount, sharpnessPeak: lapMax,
    size: [w, h],
  };
}, { frames, sharpnessFrame });

const rows = [];
for (const preset of ['off', 'dlaa', 'quality', 'balanced', 'performance']) {
  await page.evaluate(preset => window.__twinscan.action('renderMode', preset), preset);
  await page.waitForTimeout(1400);
  const m = await measure(6, 3);
  const pipeline = await page.evaluate(() => window.__twinscan.scene().render_pipeline);
  rows.push({ preset, ...m, internal: pipeline?.internal ?? null });
  console.log(`${preset.padEnd(12)} internal=${String(m.size[0])}x${m.size[1]}  帧间差 均值=${m.temporalMean.toFixed(3)} 峰值=${m.temporalPeak.toFixed(1)} 变化像素=${m.temporalChangedPct.toFixed(2)}%  清晰度=${m.sharpness.toFixed(2)}`);
}

const errors = await page.evaluate(() => window.__twinscan.errors);
if (errors.length) console.log('页面错误:', errors);
await browser.close();

const base = rows.find(r => r.preset === 'off');
if (base) {
  console.log('\n相对"关闭"档位:');
  for (const r of rows) {
    if (r.preset === 'off') continue;
    console.log(`${r.preset.padEnd(12)} 清晰度 ${(r.sharpness / base.sharpness * 100).toFixed(1)}%  帧间差 ${(r.temporalMean / Math.max(base.temporalMean, 1e-6)).toFixed(1)}x`);
  }
}
if (label) console.log(`\n[${label}]`);
