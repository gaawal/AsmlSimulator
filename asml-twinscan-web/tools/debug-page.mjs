import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ headless: true, executablePath: existsSync(localChrome) ? localChrome : undefined, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('requestfailed', r => console.log('[failed]', r.url().slice(0, 120), r.failure()?.errorText));
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => console.log('[console]', m.type(), m.text().slice(0, 200)));
await page.goto('http://127.0.0.1:5173/?qa=1', { waitUntil: 'load' });
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(5000);
  const state = await page.evaluate(() => ({ ready: window.__twinscan?.ready, errors: window.__twinscan?.errors, hidden: document.querySelector('.load-screen')?.hidden, msg: document.querySelector('.load-message')?.textContent, pct: document.querySelector('.load-percent')?.textContent }));
  console.log(i, JSON.stringify(state));
  if (state.ready) break;
}
await browser.close();
