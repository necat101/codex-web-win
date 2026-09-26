import assert from "node:assert/strict";
import { chromium, type Page } from "playwright-core";
import { defaultChromeExecutable } from "../src/config";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

// Uses a fresh headless browser and local HTML only. No stored account state,
// network requests, model turns, or modifications to the user's Chrome session.
if (process.versions.bun) throw new Error("Run the compiled smoke test under Node");
const browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true });
try {
  const page = await browser.newPage();
  await page.route("**/*", route => route.abort());
  await page.setContent('<button aria-label="Stop answering">Stop</button>'
    + '<article data-testid="conversation-turn-1" data-turn="assistant"><div class="markdown">Working</div></article>');
  const worker = Object.create(ChatGptBrowserWorker.prototype) as {
    responseDomSnapshot(page: Page, index: number, recovery: boolean, trace: boolean, pending?: number): Promise<any>;
  };
  let snapshot = await worker.responseDomSnapshot(page, 0, true, true);
  assert(snapshot.probeSucceeded && snapshot.responsePresent && snapshot.running);
  // A visibility API throwing must not make every subsequent poll unreadable.
  // This failed with probeSucceeded=false before the fallback was introduced.
  await page.evaluate(() => {
    Element.prototype.checkVisibility = () => { throw new TypeError("unsupported visibility probe"); };
  });
  for (let round = 0; round < 20; round++) {
    await page.evaluate(round => {
      const text = document.createElement("div");
      text.className = "markdown";
      text.textContent = `Tool round ${round} completed`;
      document.querySelector("article")!.append(text);
    }, round);
    snapshot = await worker.responseDomSnapshot(page, 0, true, true, round % 2);
    assert(snapshot.probeSucceeded && snapshot.responsePresent && snapshot.running);
    assert(!snapshot.completionActionPresent, "Tool work must not be finalized early");
  }
  await page.evaluate(() => {
    document.querySelector('button[aria-label="Stop answering"]')!.remove();
    const copy = document.createElement("button");
    copy.setAttribute("aria-label", "Copy response");
    document.querySelector("article")!.append(copy);
  });
  snapshot = await worker.responseDomSnapshot(page, 0, true, true);
  assert(snapshot.probeSucceeded && !snapshot.running && snapshot.completionActionPresent);
  assert.equal(snapshot.visibleText, "Tool round 19 completed");
  console.log("BROWSER_INSPECTION_RECOVERY_OK: 20 tool rounds and final answer in real Chrome under Node");
} finally {
  await browser.close();
}
