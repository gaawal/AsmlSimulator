/**
 * TAA 门控诊断：直接把着色器内部的 inside / consistent / alpha 与重投影坐标读出来。
 *
 * 用法: node tools/probe-gates.mjs
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(localChrome) ? localChrome : undefined,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
page.on('pageerror', error => console.log('[pageerror]', error.message));
page.on('console', msg => { if (msg.type() === 'error') console.log('[console]', msg.text().slice(0, 300)); });

await page.goto('http://127.0.0.1:5173/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__twinscan?.ready === true, null, { timeout: 120000 });
// 刷新后默认是光刻机界面；设计面板由「开始光刻」触发，工具里显式打开。
await page.evaluate(() => window.__twinscan.action('designs'));
await page.locator('.design-card').first().click();
await page.evaluate(() => {
  for (let i = 0; i < 400; i++) {
    const state = window.__twinscan.advance(0.25);
    if (state.exposing_stage && state.exposure_progress?.die_index >= 1) return;
    if (state.state === 'done') return;
  }
});
await page.evaluate(() => {
  window.__twinscan.action('follow', false);
  window.__twinscan.action('camera', 'optics');
  window.__twinscan.action('renderMode', 'dlaa');
});
await page.waitForTimeout(1500);

await page.evaluate(() => {
  const src = document.querySelector('canvas');
  const flat = document.createElement('canvas');
  flat.width = src.width; flat.height = src.height;
  const ctx = flat.getContext('2d', { willReadFrequently: true });
  window.__stats = async () => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, flat.width, flat.height).data;
    let r = 0, g = 0, b = 0, n = 0, rLo = 0, rHi = 0;
    for (let p = 0; p < d.length; p += 4) {
      r += d[p]; g += d[p + 1]; b += d[p + 2]; n++;
      if (d[p] < 8) rLo++; else if (d[p] > 200) rHi++;
    }
    return { meanR: r / n, meanG: g / n, meanB: b / n, rZero: rLo / n, rFull: rHi / n };
  };
  window.__pipe = () => window.__twinscan.machine.pipeline;
});

for (const mode of [0, 1, 2, 3]) {
  await page.evaluate(m => window.__pipe().setDebug(m), mode);
  await page.waitForTimeout(900);
  const s = await page.evaluate(() => window.__stats());
  console.log(`debug=${mode}  通道均值 R=${s.meanR.toFixed(1)} G=${s.meanG.toFixed(1)} B=${s.meanB.toFixed(1)}   R≈0占比=${(s.rZero * 100).toFixed(1)}% R≈255占比=${(s.rFull * 100).toFixed(1)}%`);
}

await page.evaluate(() => window.__pipe().setDebug(0));

// 读取真实渲染目标：把历史缓冲换成 8 位，直接读像素看它是否收敛。
const history = await page.evaluate(async () => {
  const p = window.__pipe();
  const renderer = window.__twinscan.machine.renderer;
  const [w, h] = p.internalSize;
  const RT = p.history[0].constructor;
  const mk = () => new RT(w, h, { type: 1009, depthBuffer: false });
  p.history = [mk(), mk()];
  const read = target => {
    const buf = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(target, 0, 0, w, h, buf);
    return buf;
  };
  const shots = [];
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 120));
    shots.push(read(p.history[p.historyIndex]));
  }
  let sum = 0, peak = 0, changed = 0, n = 0;
  for (let f = 1; f < shots.length; f++) {
    const a = shots[f - 1], b = shots[f];
    for (let q = 0; q < a.length; q += 4) {
      const d = Math.abs(a[q] * 0.299 + a[q + 1] * 0.587 + a[q + 2] * 0.114 - (b[q] * 0.299 + b[q + 1] * 0.587 + b[q + 2] * 0.114));
      sum += d; peak = Math.max(peak, d); if (d > 2) changed++; n++;
    }
  }
  return { mean: sum / n, peak, changed: (changed / n) * 100, size: [w, h] };
});
console.log('历史帧缓冲帧间差:', JSON.stringify(history));

await browser.close();
