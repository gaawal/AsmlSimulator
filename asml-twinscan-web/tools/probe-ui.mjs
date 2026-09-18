/**
 * 界面布局探针：验证右上角环境/视图开关、运行行里的单步按钮、相位展示已移除，
 * 并输出整页截图便于肉眼核对。
 *
 * 用法: node tools/probe-ui.mjs [标签]
 * 需要 `npm run dev`（或 vite preview）已在 5173 端口提供服务。
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const tag = process.argv[2] || 'current';
const outDir = 'artifacts/ui';
mkdirSync(outDir, { recursive: true });
const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(localChrome) ? localChrome : undefined,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', error => console.log('[pageerror]', error.message));
await page.goto('http://127.0.0.1:5173/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__twinscan?.ready === true, null, { timeout: 120000 });
await page.waitForTimeout(400);

const topRight = await page.$$eval('.scene-toggles .pill-toggle', els => els.map(el => {
  const r = el.getBoundingClientRect();
  const area = el.closest('.scene-panel').getBoundingClientRect();
  return { text: el.textContent.trim(), pressed: el.getAttribute('aria-pressed'), x: Math.round(r.x), y: Math.round(r.y), right_edge: Math.round(area.right - r.right), top_edge: Math.round(r.top - area.top) };
}));
console.log('右上角开关:', JSON.stringify(topRight));

const runRow = await page.$$eval('.run-row > *', els => els.map(el => ({ cls: el.className, text: el.textContent.trim().slice(0, 10), hidden: el.hidden })));
console.log('运行行:', JSON.stringify(runRow));
console.log('相位画布是否仍存在:', Boolean(await page.$('.phase-demo')));
console.log('旧的开关行是否仍存在:', Boolean(await page.$('.switch-row')));

// 黄光环境：点击后应变为黄光并回填按钮
await page.click('[data-toggle=lighting]');
await page.waitForTimeout(300);
console.log('点击黄光后:', JSON.stringify(await page.evaluate(() => ({
  pressed: document.querySelector('[data-toggle=lighting]').getAttribute('aria-pressed'),
  label: document.querySelector('[data-toggle=lighting] span').textContent,
  yellowMode: document.getElementById('app')?.classList.contains('yellow-mode'),
  snapshot: window.__twinscan.snapshot().web?.lighting,
}))));
await page.screenshot({ path: `${outDir}/${tag}-yellow.png` });

// 跟随特写：关闭后按钮应回到未选中
await page.click('[data-toggle=follow]');
await page.waitForTimeout(200);
console.log('点击跟随后:', JSON.stringify(await page.evaluate(() => ({
  pressed: document.querySelector('[data-toggle=follow]').getAttribute('aria-pressed'),
  snapshot: window.__twinscan.snapshot().web?.follow,
}))));

// 单步：与开始光刻同一行，开启后出现「下一步」
await page.click('[data-toggle=singleStep]');
await page.waitForTimeout(200);
console.log('点击单步后:', JSON.stringify(await page.evaluate(() => ({
  pressed: document.querySelector('[data-toggle=singleStep]').getAttribute('aria-pressed'),
  stepVisible: !document.querySelector('.step-button').hidden,
}))));

// 复位到默认视图再截图
await page.click('[data-toggle=lighting]');
await page.click('[data-toggle=singleStep]');
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/${tag}-full.png` });
await page.locator('.scene-panel').screenshot({ path: `${outDir}/${tag}-scene.png` });
console.log('截图已保存到', outDir);

const errors = await page.evaluate(() => window.__twinscan.errors);
console.log(errors.length ? `页面错误: ${JSON.stringify(errors.slice(0, 3))}` : '✅ 无页面错误');
await browser.close();
