// Apify Actor: Mopar 2026 Exterior Accessories Crawler
// Runtime: Node.js + Playwright (via Apify SDK)
//
// HOW TO USE ON APIFY:
// 1. Create a new Actor on Apify (Console -> Actors -> Create new -> "Empty project (JavaScript)")
// 2. Choose the "Playwright + Chrome" template/base image so the browser is available
// 3. Replace the generated main.js with this file
// 4. Replace package.json with the one provided alongside this file
// 5. Run the actor. Output rows land in the Actor's default Dataset; export as CSV/Excel from there.
//
// WHAT THIS SCRIPT DOES:
// - Step A: For each model root URL, opens the page and tries to discover the JSON API
//   the product grid uses (by listening to network responses). Logs findings to the
//   "api-discovery" key-value store entry so you can inspect what was found.
// - Step B: Enumerates 2026 trims/engines per model from the vehicle selector.
// - Step C: For each vehicle+trim+engine, loads the Exterior Accessories landing page,
//   discovers subcategories, and crawls each subcategory's product grid (with pagination).
// - Step D: Visits each product detail page and extracts the required fields.
// - Step E: Pushes one row per (SKU + Trim) to the Dataset, with dedupe.
//
// NOTE: Selectors below are BEST-EFFORT based on the site's known structure as of this
// writing. Mopar's frontend may change. If a selector returns nothing, the script logs
// a warning and moves on rather than crashing — check the run log and adjust selectors
// in the marked SELECTOR CONFIG section below.

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, KeyValueStore, log } from 'crawlee';

await Actor.init();

// ----------------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------------

const TARGET_YEAR = '2026';
const COUNTRY = 'US';

// Base model root URLs to start from. Add/remove as needed.
const MODEL_ROOTS = [
  { make: 'Jeep', model: 'Wrangler', url: 'https://store.mopar.com/v-jeep-wrangler' },
  { make: 'Jeep', model: 'Gladiator', url: 'https://store.mopar.com/v-jeep-gladiator' },
  { make: 'Jeep', model: 'Grand Cherokee', url: 'https://store.mopar.com/v-jeep-grand-cherokee' },
  { make: 'Jeep', model: 'Compass', url: 'https://store.mopar.com/v-jeep-compass' },
  { make: 'Jeep', model: 'Wagoneer', url: 'https://store.mopar.com/v-jeep-wagoneer' },
  { make: 'Jeep', model: 'Grand Wagoneer', url: 'https://store.mopar.com/v-jeep-grand-wagoneer' },
  { make: 'Dodge', model: 'Charger', url: 'https://store.mopar.com/v-dodge-charger' },
  { make: 'Dodge', model: 'Durango', url: 'https://store.mopar.com/v-dodge-durango' },
  { make: 'Dodge', model: 'Challenger', url: 'https://store.mopar.com/v-dodge-challenger' },
  { make: 'Dodge', model: 'Hornet', url: 'https://store.mopar.com/v-dodge-hornet' },
  { make: 'Ram', model: '1500', url: 'https://store.mopar.com/v-ram-1500' },
  { make: 'Ram', model: '2500', url: 'https://store.mopar.com/v-ram-2500' },
  { make: 'Ram', model: '3500', url: 'https://store.mopar.com/v-ram-3500' },
  { make: 'Ram', model: 'ProMaster 1500', url: 'https://store.mopar.com/v-ram-promaster-1500' },
  { make: 'Ram', model: 'ProMaster 2500', url: 'https://store.mopar.com/v-ram-promaster-2500' },
  { make: 'Ram', model: 'ProMaster 3500', url: 'https://store.mopar.com/v-ram-promaster-3500' },
  { make: 'Ram', model: 'ProMaster City', url: 'https://store.mopar.com/v-ram-promaster-city' },
  { make: 'Chrysler', model: 'Pacifica', url: 'https://store.mopar.com/v-chrysler-pacifica' },
  { make: 'Chrysler', model: '300', url: 'https://store.mopar.com/v-chrysler-300' },
];

// ----------------------------------------------------------------------------------
// SELECTOR CONFIG -- adjust these if the site structure differs from what's assumed
// ----------------------------------------------------------------------------------

const SELECTORS = {
  // Vehicle selector dropdowns on a model root page
  yearDropdown: 'select[name="year"], #year-select, [data-testid="year-select"]',
  trimDropdown: 'select[name="trim"], #trim-select, [data-testid="trim-select"]',
  engineDropdown: 'select[name="engine"], #engine-select, [data-testid="engine-select"]',

  // Category sidebar on a vehicle-specific page
  exteriorAccessoriesLink: 'a:has-text("Exterior Accessories")',
  subcategoryLinks: 'nav a, .category-sidebar a, [data-testid="subcategory-link"]',

  // Product grid
  productCard: '.product-card, [data-testid="product-card"], .product-tile',
  productCardLink: 'a',
  nextPageButton: 'a:has-text("Next"), button:has-text("Next"), [aria-label="Next page"]',

  // Product detail page
  detailSku: '[data-testid="sku"], .product-sku, .sku-number',
  detailName: 'h1, .product-title, [data-testid="product-name"]',
  detailDescription: '.product-description, [data-testid="description"]',
  detailFeatures: '.product-features li, [data-testid="feature-list"] li, .bullet-features li',
  detailPrice: '.product-price, [data-testid="price"], .msrp',
  detailFitment: '.fitment-info, [data-testid="fitment"], .compatibility',
  detailReplaces: '.replaces-info, [data-testid="replaces"]',
  detailInstall: '.installation-notes, [data-testid="installation-notes"]',
};

// ----------------------------------------------------------------------------------
// STATE / DEDUPE
// ----------------------------------------------------------------------------------

const seenSkuTrim = new Set();
const apiFindings = [];

function cleanText(s) {
  if (!s) return null;
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null;
}

function dedupeKey(sku, trim) {
  return `${sku}__${trim}`;
}

// ----------------------------------------------------------------------------------
// NETWORK LISTENER (Step A: API discovery)
// ----------------------------------------------------------------------------------

function attachApiDiscovery(page, contextLabel) {
  page.on('response', async (response) => {
    try {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      const keywordHit = /accessor|product|catalog|api|graphql/i.test(url);
      if (keywordHit && ct.includes('application/json')) {
        let bodySnippet = null;
        try {
          const json = await response.json();
          bodySnippet = JSON.stringify(json).slice(0, 500);
        } catch {
          // not parseable, skip body capture
        }
        apiFindings.push({ contextLabel, url, status: response.status(), bodySnippet });
        log.info(`[API DISCOVERY] ${contextLabel} -> ${url}`);
      }
    } catch {
      // ignore listener errors
    }
  });
}

// ----------------------------------------------------------------------------------
// CRAWLER
// ----------------------------------------------------------------------------------

const crawler = new PlaywrightCrawler({
  maxConcurrency: 2, // politeness: keep this low
  requestHandlerTimeoutSecs: 90,
  navigationTimeoutSecs: 60,

  async requestHandler({ request, page, enqueueLinks, log: reqLog }) {
    const { label, make, model, trim, engine, category, subCategory } = request.userData;

    attachApiDiscovery(page, `${make} ${model} ${label || ''}`);

    await page.waitForLoadState('networkidle').catch(() => {
      reqLog.warning(`Network idle wait timed out for ${request.url}`);
    });

    // -------------------------------------------------------------
    // LABEL: MODEL_ROOT -> discover 2026 trims/engines
    // -------------------------------------------------------------
    if (label === 'MODEL_ROOT') {
      reqLog.info(`Discovering trims for ${make} ${model}`);

      // Try to select year=2026 if a year dropdown exists
      const yearEl = await page.$(SELECTORS.yearDropdown);
      if (yearEl) {
        try {
          await page.selectOption(SELECTORS.yearDropdown, { label: TARGET_YEAR });
          await page.waitForTimeout(1500);
        } catch {
          reqLog.warning(`Could not select year 2026 for ${make} ${model}`);
        }
      }

      const trimEl = await page.$(SELECTORS.trimDropdown);
      let trims = [];
      if (trimEl) {
        trims = await page.$$eval(`${SELECTORS.trimDropdown} option`, (opts) =>
          opts.map((o) => o.textContent.trim()).filter((t) => t && !/select/i.test(t))
        );
      }

      if (trims.length === 0) {
        reqLog.warning(
          `No trims found via dropdown for ${make} ${model} -- selector may need adjustment. Saving page HTML for inspection.`
        );
        const html = await page.content();
        await KeyValueStore.setValue(`NO_TRIMS_${make}_${model}`.replace(/\s+/g, '_'), html, {
          contentType: 'text/html',
        });
        return;
      }

      for (const trimName of trims) {
        // Select this trim, then read engine options
        try {
          await page.selectOption(SELECTORS.trimDropdown, { label: trimName });
          await page.waitForTimeout(1000);
        } catch {
          reqLog.warning(`Could not select trim ${trimName} for ${make} ${model}`);
          continue;
        }

        let engines = ['default'];
        const engineEl = await page.$(SELECTORS.engineDropdown);
        if (engineEl) {
          const engineOpts = await page.$$eval(`${SELECTORS.engineDropdown} option`, (opts) =>
            opts.map((o) => o.textContent.trim()).filter((t) => t && !/select/i.test(t))
          );
          if (engineOpts.length) engines = engineOpts;
        }

        for (const engineName of engines) {
          // Build the slug-based vehicle URL pattern; if this doesn't match
          // the real site behavior, fall back to reading window.location after
          // making the selections (left as a TODO if needed).
          const slug = (s) =>
            s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const vehicleUrl = `https://store.mopar.com/v-${TARGET_YEAR}-${slug(make)}-${slug(
            model
          )}--${slug(trimName)}--${slug(engineName)}/accessories-exterior-accessories`;

          await crawler.addRequests([
            {
              url: vehicleUrl,
              userData: {
                label: 'EXTERIOR_LANDING',
                make,
                model,
                trim: trimName,
                engine: engineName,
              },
            },
          ]);
        }
      }
    }

    // -------------------------------------------------------------
    // LABEL: EXTERIOR_LANDING -> discover subcategories
    // -------------------------------------------------------------
    if (label === 'EXTERIOR_LANDING') {
      const subLinks = await page.$$eval(SELECTORS.subcategoryLinks, (links) =>
        links
          .map((l) => ({ href: l.href, text: l.textContent.trim() }))
          .filter((l) => l.href && l.href.includes('exterior-accessories'))
      );

      if (subLinks.length === 0) {
        reqLog.warning(
          `No subcategories found for ${make} ${model} ${trim} -- page may have 404'd or selector needs adjustment.`
        );
        return;
      }

      const uniqueSubs = Array.from(new Map(subLinks.map((s) => [s.href, s])).values());

      for (const sub of uniqueSubs) {
        await crawler.addRequests([
          {
            url: sub.href,
            userData: {
              label: 'SUBCATEGORY',
              make,
              model,
              trim,
              engine,
              category: 'Exterior Accessories',
              subCategory: sub.text,
            },
          },
        ]);
      }
    }

    // -------------------------------------------------------------
    // LABEL: SUBCATEGORY -> product grid + pagination
    // -------------------------------------------------------------
    if (label === 'SUBCATEGORY') {
      const productLinks = await page.$$eval(
        `${SELECTORS.productCard} ${SELECTORS.productCardLink}`,
        (links) => links.map((l) => l.href)
      );

      const uniqueLinks = [...new Set(productLinks)];

      if (uniqueLinks.length === 0) {
        reqLog.warning(
          `No products found in ${make} ${model} ${trim} / ${subCategory} -- check selector or category may be empty for this trim.`
        );
      }

      for (const link of uniqueLinks) {
        await crawler.addRequests([
          {
            url: link,
            userData: {
              label: 'PRODUCT_DETAIL',
              make,
              model,
              trim,
              engine,
              category,
              subCategory,
            },
          },
        ]);
      }

      // Pagination
      const nextBtn = await page.$(SELECTORS.nextPageButton);
      if (nextBtn) {
        const isDisabled = await nextBtn.getAttribute('disabled');
        if (!isDisabled) {
          const href = await nextBtn.getAttribute('href');
          if (href) {
            await crawler.addRequests([
              {
                url: href.startsWith('http') ? href : new URL(href, request.url).toString(),
                userData: { label: 'SUBCATEGORY', make, model, trim, engine, category, subCategory },
              },
            ]);
          } else {
            // JS-driven pagination (no href) -- click and re-extract in place
            try {
              await nextBtn.click();
              await page.waitForTimeout(2000);
              const morelinks = await page.$$eval(
                `${SELECTORS.productCard} ${SELECTORS.productCardLink}`,
                (links) => links.map((l) => l.href)
              );
              for (const link of [...new Set(morelinks)]) {
                await crawler.addRequests([
                  {
                    url: link,
                    userData: { label: 'PRODUCT_DETAIL', make, model, trim, engine, category, subCategory },
                  },
                ]);
              }
            } catch {
              reqLog.warning(`Pagination click failed for ${request.url}`);
            }
          }
        }
      }
    }

    // -------------------------------------------------------------
    // LABEL: PRODUCT_DETAIL -> extract fields, push row
    // -------------------------------------------------------------
    if (label === 'PRODUCT_DETAIL') {
      const sku = cleanText(await page.$eval(SELECTORS.detailSku, (el) => el.textContent).catch(() => null));
      const name = cleanText(await page.$eval(SELECTORS.detailName, (el) => el.textContent).catch(() => null));
      const description = cleanText(
        await page.$eval(SELECTORS.detailDescription, (el) => el.textContent).catch(() => null)
      );
      const features = await page
        .$$eval(SELECTORS.detailFeatures, (els) => els.map((e) => e.textContent.trim()).filter(Boolean))
        .catch(() => []);
      const priceRaw = cleanText(await page.$eval(SELECTORS.detailPrice, (el) => el.textContent).catch(() => null));
      const fitment = cleanText(await page.$eval(SELECTORS.detailFitment, (el) => el.textContent).catch(() => null));
      const replaces = cleanText(await page.$eval(SELECTORS.detailReplaces, (el) => el.textContent).catch(() => null));
      const installNotes = cleanText(
        await page.$eval(SELECTORS.detailInstall, (el) => el.textContent).catch(() => null)
      );

      if (!sku) {
        reqLog.warning(`No SKU found on product page ${request.url} -- skipping row, check detailSku selector.`);
        return;
      }

      const key = dedupeKey(sku, trim);
      if (seenSkuTrim.has(key)) {
        reqLog.info(`Duplicate SKU+Trim skipped: ${key}`);
        return;
      }
      seenSkuTrim.add(key);

      const row = {
        Country: COUNTRY,
        Year: TARGET_YEAR,
        Make: make,
        Model: model,
        Trim: trim || 'NULL',
        'Part Number/SKU': sku,
        'Part Name': name || 'NULL',
        'Other Name/Alias': 'NULL',
        Description: description || 'NULL',
        'Key Features': features.length ? features.join('; ') : 'NULL',
        Condition: 'New',
        'Replaces Part Number': replaces || 'NULL',
        Category: category || 'Exterior Accessories',
        'Sub Category': subCategory || 'NULL',
        MSRP: priceRaw || 'NULL',
        'Fitment Information': fitment || 'NULL',
        'Installation Notes': installNotes || 'NULL',
        'Accessory Type': subCategory || 'NULL',
        'Product URL': request.url,
      };

      await Dataset.pushData(row);
      reqLog.info(`Saved: ${make} ${model} ${trim} | ${sku} | ${name}`);
    }
  },

  async failedRequestHandler({ request, log: reqLog }) {
    reqLog.error(`Request failed permanently: ${request.url}`);
  },
});

// ----------------------------------------------------------------------------------
// SEED REQUESTS
// ----------------------------------------------------------------------------------

await crawler.addRequests(
  MODEL_ROOTS.map((m) => ({
    url: m.url,
    userData: { label: 'MODEL_ROOT', make: m.make, model: m.model },
  }))
);

await crawler.run();

// Save API discovery findings for inspection
await KeyValueStore.setValue('api-discovery-findings', apiFindings);

log.info(`Crawl complete. Total unique SKU+Trim rows: ${seenSkuTrim.size}`);

await Actor.exit();
