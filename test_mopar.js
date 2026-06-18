const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({
        headless: false
    });

    const page = await browser.newPage();

    await page.goto('https://store.mopar.com', {
        waitUntil: 'networkidle'
    });

    console.log('Title:', await page.title());

    const links = await page.locator('a').evaluateAll(
        els => els.map(e => ({
            text: e.innerText,
            href: e.href
        }))
    );

    console.log('Total Links:', links.length);

    console.log(links.slice(0, 50));

    await page.pause();
})();
