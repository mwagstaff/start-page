// Run with PLAYWRIGHT_MODULE pointing to an installed playwright/index.mjs.
import { writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = process.argv[2] || 'performance/2026-11-16';
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const mobile of [false, true]) {
    const label = mobile ? 'mobile' : 'desktop';
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, locale: 'en-GB', timezoneId: 'Europe/London', isMobile: mobile, deviceScaleFactor: mobile ? 3 : 1, recordHar: { path: `${out}/${label}.har`, content: 'omit', mode: 'full' } });
    await context.addInitScript(() => {
      window.perfReview = { lcp: [], shifts: [], longTasks: [] };
      for (const [type, key] of [['largest-contentful-paint', 'lcp'], ['layout-shift', 'shifts'], ['longtask', 'longTasks']]) {
        new PerformanceObserver(list => { for (const e of list.getEntries()) window.perfReview[key].push({ ...e.toJSON(), element: e.element?.tagName, text: e.element?.textContent?.slice(0, 80), hadRecentInput: e.hadRecentInput }); }).observe({ type, buffered: true });
      }
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    if (mobile) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 93750 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    for (const state of ['cold', 'warm']) {
      await page.goto('https://tab1.net/', { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(mobile ? 12000 : 5000);
      const data = await page.evaluate(() => ({ ...window.perfReview, nav: performance.getEntriesByType('navigation')[0].toJSON(), paint: performance.getEntriesByType('paint').map(e => e.toJSON()), resources: performance.getEntriesByType('resource').map(e => e.toJSON()), domElements: document.querySelectorAll('*').length, cards: document.querySelectorAll('.card').length }));
      results.push({ label, state, errors: [...errors], ...data });
      await page.screenshot({ path: `${out}/${label}-${state}.png`, fullPage: true });
      console.log(JSON.stringify({ label, state, ttfb: data.nav.responseStart, dcl: data.nav.domContentLoadedEventEnd, load: data.nav.loadEventEnd, lcp: data.lcp.at(-1)?.startTime, clsRaw: data.shifts.filter(e => !e.hadRecentInput).reduce((s,e) => s + e.value, 0), longTaskMs: data.longTasks.reduce((s,e) => s+e.duration,0), requests: data.resources.length + 1, errors }));
      await page.goto('about:blank');
    }
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(`${out}/browser.json`, JSON.stringify({ browser: 'Chromium 151; fresh isolated contexts; UK locale', mobileThrottle: '150ms latency, 1.6Mbps down, 750kbps up, 4x CPU', results }, null, 2));
