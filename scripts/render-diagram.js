// Renders architecture-diagram.svg to architecture-diagram.png with headless Chromium.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { config } from '../src/config.js';

const svg = fs.readFileSync(new URL('../architecture-diagram.svg', import.meta.url), 'utf8');
const browser = await puppeteer.launch({ executablePath: config.render.executablePath, headless: config.render.headless, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1700, height: 1200, deviceScaleFactor: 2 });
await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
await page.screenshot({ path: fileURLToPath(new URL('../architecture-diagram.png', import.meta.url)), clip: { x: 0, y: 0, width: 1700, height: 1200 } });
await browser.close();
console.log('wrote architecture-diagram.png');
