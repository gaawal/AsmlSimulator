/**
 * 量测子系统（光栅尺 / 激光干涉仪）的布局与动画校验截图。
 *
 * 用法: node tools/capture-metrology.mjs [标签]
 * 输出 artifacts/metrology/<标签>-<视角>.png，并打印 metrology debugState。
 * 需要 `npm run dev` 已启动。
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const label = process.argv[2] ?? 'metro';
const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'artifacts', 'metrology');
mkdirSync(target, { recursive: true });

const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(localChrome) ? localChrome : undefined,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
page.on('pageerror', error => console.log('[pageerror]', error.message));
page.on('console', msg => { if (msg.type() === 'error') console.log('[console]', msg.text().slice(0, 240)); });

await page.goto('http://127.0.0.1:5173/?qa=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__twinscan?.ready === true, null, { timeout: 120000 });

// 刷新后默认是光刻机界面，设计面板由"开始光刻"触发；截图工具显式打开它。
await page.evaluate(() => window.__twinscan.action('designs'));
await page.locator('.design-card').first().click();
await page.waitForFunction(() => window.__twinscan.snapshot().state !== 'ready', null, { timeout: 20000 });
// 推进到归零结束、两组 PSD 全部对准角锥的那一刻再截图，光栅尺寻零与干涉仪激光都在亮。
await page.evaluate(() => {
  const qa = window.__twinscan;
  for (let i = 0; i < 2000; i++) {
    qa.advance(0.02);
    const zero = qa.machine.debugState().metrology.zero_module || [];
    if (zero.filter(z => z.hit).length >= 6) break;
  }
});
await page.evaluate(() => window.__twinscan.action('follow', false));

const aim = (eye, look) => page.evaluate(({ eye, look }) => {
  const machine = window.__twinscan.machine;
  machine.cameraTween = null;
  machine.camera.position.set(...eye);
  machine.controls.target.set(...look);
  machine.controls.update();
  machine.camera.updateMatrixWorld(true);
}, { eye, look });

const shot = async (name, eye, look, clip) => {
  await aim(eye, look);
  await page.waitForTimeout(1200);
  const file = resolve(target, `${label}-${name}.png`);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  console.log('saved', file);
};

// 工件台特写：两个工位的 L 型镜与四周光学头。
await shot('stage', [0.2, 1.75, 2.9], [0.2, 1.2, 0.6], { x: 330, y: 190, width: 940, height: 620 });
// 掩模台光栅尺特写。
await shot('reticle', [1.4, 3.75, 0.95], [1.4, 3.34, -0.3], { x: 400, y: 200, width: 820, height: 560 });
// 整机视角看整体布局。
await shot('front', [0, 5.0, 14], [0, 1.65, 0.3]);

const metrology = await page.evaluate(() => window.__twinscan.scene().metrology);
console.log('metrology:', JSON.stringify(metrology, null, 1));
const errors = await page.evaluate(() => window.__twinscan.errors);
if (errors.length) console.log('页面错误:', errors);
await browser.close();
