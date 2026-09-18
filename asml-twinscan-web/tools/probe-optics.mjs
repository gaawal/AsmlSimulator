/**
 * 光效校验：推进到曝光阶段，确认粒子流、光束、命中反馈都在工作，且页面无报错。
 *
 * 用法: node tools/probe-optics.mjs
 * 需要 `npm run dev` 已启动。
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(localChrome) ? localChrome : undefined,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', error => console.log('[pageerror]', error.message));
page.on('console', msg => { if (msg.type() === 'error') console.log('[console]', msg.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:5173/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__twinscan?.ready === true, null, { timeout: 120000 });

// 刷新后应当停在光刻机界面：没有设计面板。
const modalOnLoad = await page.evaluate(() => !document.querySelector('.modal-host').hidden);
console.log(`刷新后是否弹出设计面板（期望 false）: ${modalOnLoad}`);
console.log(`启动按钮文案: ${await page.locator('[data-action=toggle] span').textContent()}`);

// 点"开始光刻"才应弹出设计选择。
await page.locator('[data-action=toggle]').click();
await page.waitForTimeout(300);
const modalAfterStart = await page.evaluate(() => !document.querySelector('.modal-host').hidden);
console.log(`点击开始光刻后是否弹出设计面板（期望 true）: ${modalAfterStart}`);
// 刷新后默认是光刻机界面；设计面板由「开始光刻」触发，工具里显式打开。
await page.evaluate(() => window.__twinscan.action('designs'));
await page.locator('.design-card').first().click();
await page.waitForFunction(() => window.__twinscan.snapshot().state !== 'ready', null, { timeout: 20000 });

// 推进到曝光阶段。
const optics = await page.evaluate(() => {
  const qa = window.__twinscan;
  let exposed = null;
  for (let i = 0; i < 4000; i++) {
    qa.advance(0.05);
    const scene = qa.machine.debugState();
    if (scene.motion?.visible_beam_count > 0) { exposed = scene; break; }
  }
  return exposed;
});
if (!optics) { console.log('❌ 未进入曝光阶段'); await browser.close(); process.exit(1); }
console.log('光束数量:', optics.motion.beam_count, '可见:', optics.motion.visible_beam_count);
console.log('粒子流:', JSON.stringify(optics.motion.particle_stream));
console.log('绘制调用:', optics.renderer.draw_calls, '三角面:', optics.renderer.triangles);
console.log('量测实现:', optics.metrology.source || 'geometric_overlay', '| 干涉仪记录:', optics.metrology.interferometer?.length ?? 0, '| 光束:', optics.metrology.interferometer?.filter(b => b.hit).length ?? 0);

const errors = await page.evaluate(() => window.__twinscan.errors);
console.log(errors.length ? `❌ 页面错误: ${JSON.stringify(errors.slice(0, 3))}` : '✅ 无页面错误');
await browser.close();
