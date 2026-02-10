const fetch = require('node-fetch');
const fs = require('fs');
const { JSDOM } = require('jsdom');

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  scraperApiKey: process.env.SCRAPER_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  recipientEmail: process.env.RECIPIENT_EMAIL,
  searches: [
    {
      name: "Maton Acoustic Guitar",
      term: 'Maton EM425',
      expectedPrice: 2000,
      postcode: '5000',
      distance: '200',
      topN: 5,
      urgentHours: 4,
      unicornThreshold: 85,
      auctionOnly: false
    },
    {
      name: "Gibson Les Paul",
      term: 'Gibson Les Paul Standard',
      expectedPrice: 3500,
      postcode: '5000',
      distance: '200',
      topN: 5,
      urgentHours: 6,
      unicornThreshold: 88,
      auctionOnly: false
    },
    {
      name: "MacBook Pro M3",
      term: 'MacBook Pro M3',
      expectedPrice: 2500,
      postcode: '5000',
      distance: '100',
      topN: 5,
      urgentHours: 3,
      unicornThreshold: 90,
      auctionOnly: false
    },
    {
      name: "Fender Stratocaster",
      term: 'Fender Stratocaster American',
      expectedPrice: 2200,
      postcode: '5000',
      distance: '200',
      topN: 5,
      urgentHours: 4,
      unicornThreshold: 85,
      auctionOnly: false
    },
    {
      name: "DJI Drone",
      term: 'DJI Mavic 3',
      expectedPrice: 1800,
      postcode: '5000',
      distance: '150',
      topN: 5,
      urgentHours: 2,
      unicornThreshold: 87,
      auctionOnly: false
    }
  ]
};

const GEMINI_MODEL = 'gemini-2.0-flash-exp';
let logMessages = [];

// ═══════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════
function validateConfig() {
  const required = ['scraperApiKey', 'geminiApiKey', 'recipientEmail'];
  const missing = required.filter(key => !CONFIG[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

// ═══════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════
function log(message) {
  const timestamp = new Date().toISOString();
  const logMsg = `[${timestamp}] ${message}`;
  console.log(logMsg);
  logMessages.push(logMsg);
}

function saveLog() {
  try {
    fs.writeFileSync('scan-log.txt', logMessages.join('\n'));
    log('Log saved to scan-log.txt');
  } catch (error) {
    console.error('Failed to save log:', error.message);
  }
}

// ═══════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithDelay(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await delay(3000 + Math.random() * 4000);
      const proxy = `https://api.scraperapi.com?api_key=${CONFIG.scraperApiKey}&url=${encodeURIComponent(url)}&render=true`;
      const res = await fetch(proxy, { timeout: 60000 });
      if (!res.ok) throw new Error(`ScraperAPI ${res.status}: ${res.statusText}`);
      return await res.text();
    } catch (error) {
      log(`  Fetch attempt ${i + 1}/${retries} failed: ${error.message}`);
      if (i === retries - 1) throw error;
      await delay(5000 * (i + 1));
    }
  }
}

async function callGeminiAPI(prompt, temperature = 0.3, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${CONFIG.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: temperature, maxOutputTokens: 8000 }
          }),
          timeout: 60000
        }
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`Gemini API ${response.status}: ${error.error?.message || 'Unknown error'}`);
      }
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('No response from Gemini');
      return text;
    } catch (error) {
      log(`  Gemini attempt ${i + 1}/${retries} failed: ${error.message}`);
      if (i === retries - 1) throw error;
      await delay(3000 * (i + 1));
    }
  }
}

function extractPrice(priceStr) {
  if (!priceStr) return null;
  const rangeMatch = priceStr.match(/AU\s*\$?([\d,]+\.?\d*)\s*to\s*AU\s*\$?([\d,]+\.?\d*)/i);
  if (rangeMatch) return parseFloat(rangeMatch[1].replace(/,/g, ''));
  const match = priceStr.match(/[\d,]+\.?\d*/);
  if (!match) return null;
  return parseFloat(match[0].replace(/,/g, ''));
}

function parseTimeLeft(timeStr) {
  if (!timeStr || timeStr === 'N/A') return null;
  const daysMatch = timeStr.match(/(\d+)d/);
  const hoursMatch = timeStr.match(/(\d+)h/);
  const minsMatch = timeStr.match(/(\d+)m/);
  let minutes = 0;
  if (daysMatch) minutes += parseInt(daysMatch[1]) * 24 * 60;
  if (hoursMatch) minutes += parseInt(hoursMatch[1]) * 60;
  if (minsMatch) minutes += parseInt(minsMatch[1]);
  return minutes;
}

// ═══════════════════════════════════════════════════════════
// AI RANKING
// ═══════════════════════════════════════════════════════════
async function rankItemsWithGemini(items, searchTerm, expectedPrice, urgentThresholdMins) {
  if (items.length === 0) return [];
  const itemsData = items.map((item, i) => ({
    id: i,
    title: item.title,
    price: item.price,
    priceNumeric: extractPrice(item.price) || 0,
    condition: item.condition,
    shipping: item.shipping,
    location: item.distance,
    isAuction: item.isAuction,
    timeLeft: item.timeLeft,
    timeLeftMinutes: parseTimeLeft(item.timeLeft),
    bidCount: item.bidCount,
    sellerRating: item.sellerRating
  }));

  const urgentHours = (urgentThresholdMins / 60).toFixed(1);

  const prompt = `You are an expert eBay deal analyzer for "${searchTerm}". ${expectedPrice ? `Expected fair market value: AUD $${expectedPrice}.` : ''}
TASK: Rank these items by VALUE based on title, price, condition, shipping, and auction timing.
Items to analyze:
${JSON.stringify(itemsData, null, 2)}
RANKING CRITERIA:
1. Relevance
2. Auction timing (urgent deals +20)
3. Price vs expected
4. Condition
5. Bid activity
6. Shipping
7. Seller rating
OUTPUT: JSON { "rankings": [ { "id":0, "rank":1, "score":95, "reasoning":"..." } ] }`;

  const response = await callGeminiAPI(prompt, 0.2);
  let jsonStr = response.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  }
  try {
    const parsed = JSON.parse(jsonStr);
    return parsed.rankings || [];
  } catch (error) {
    log(`  Failed to parse Gemini response: ${error.message}`);
    log(`  Raw response: ${jsonStr.substring(0, 200)}...`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// EBAY SCRAPING
// ═══════════════════════════════════════════════════════════
async function scrapeEbay(searchConfig) {
  log(`\n🔍 Searching for: ${searchConfig.name} (${searchConfig.term})`);
  let ebayUrl = `https://www.ebay.com.au/sch/i.html?_from=R40&_nkw=${encodeURIComponent(searchConfig.term)}&_sadis=${searchConfig.distance}&_stpos=${searchConfig.postcode}&_fspt=1&LH_PrefLoc=99&rt=nc`;
  if (searchConfig.auctionOnly) ebayUrl += '&LH_Auction=1';
  log(`  URL: ${ebayUrl}`);

  const html = await fetchWithDelay(ebayUrl);
  log(`  HTML length: ${html.length.toLocaleString()} chars`);

  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const containers = doc.querySelectorAll('ul.srp-results li.s-item, ul.srp-results li.s-card, li.s-item');
  log(`  Found ${containers.length} potential containers`);

  let items = [];

  containers.forEach((li) => {
    let titleEl = li.querySelector('.s-item__title, .s-card__title');
    const title = titleEl ? titleEl.textContent.trim().replace(/\s+/g, ' ') : 'N/A';
    const linkEl = li.querySelector('a[href*="itm/"], a.s-item__link');
    const link = linkEl ? linkEl.href : '#';
    let priceEl = li.querySelector('.s-item__price, .s-card__price');
    const price = priceEl ? priceEl.textContent.trim() : 'N/A';
    const condEl = li.querySelector('.s-item__subtitle, .SECONDARY_INFO');
    const condition = condEl ? condEl.textContent.trim() : 'N/A';
    let shipping = 'N/A';
    const shipEl = li.querySelector('.s-item__shipping, [class*="shipping"]');
    if (shipEl) shipping = shipEl.textContent.trim();
    let dist = 'N/A';
    const locEl = li.querySelector('.s-item__location');
    if (locEl) dist = locEl.textContent.trim();
    const imgEl = li.querySelector('img[src*="ebayimg"], img[data-src*="ebayimg"]');
    let imgSrc = imgEl ? (imgEl.src || imgEl.dataset?.src || '') : '';
    if (imgSrc) imgSrc = imgSrc.replace(/\/s-l\d+/, '/s-l500').split('?')[0];

    let timeLeft = 'N/A', bidCount = 0, isAuction = false;
    const timeEl = li.querySelector('.s-item__time-left, .s-item__timeLeft');
    if (timeEl) { timeLeft = timeEl.textContent.trim(); isAuction = true; }
    const bidEl = li.querySelector('.s-item__bids, [class*="bid"]');
    if (bidEl) { const bidMatch = bidEl.textContent.trim().match(/(\d+)\s*bid/i); if (bidMatch) bidCount = parseInt(bidMatch[1]); if (bidEl.textContent.toLowerCase().includes('bid')) isAuction = true; }

    const sellerEl = li.querySelector('.s-item__seller-info');
    let sellerRating = 'N/A';
    if (sellerEl) { const ratingMatch = sellerEl.textContent.match(/([\d.]+)%/); if (ratingMatch) sellerRating = ratingMatch[1] + '%'; }

    if (title === 'N/A' || price === 'N/A' || !link.includes('itm/') || title.toLowerCase().includes('shop on ebay')) return;

    items.push({ title, price, condition, shipping, distance: dist, link, img: imgSrc, timeLeft, bidCount, isAuction, sellerRating, aiScore: 0, aiReasoning: '' });
  });

  log(`  Extracted ${items.length} valid items`);

  if (items.length === 0) return [];

  const urgentThresholdMins = searchConfig.urgentHours * 60;
  try {
    const rankings = await rankItemsWithGemini(items, searchConfig.term, searchConfig.expectedPrice, urgentThresholdMins);
    if (rankings.length > 0) {
      rankings.forEach(r => { if (items[r.id]) { items[r.id].aiScore = r.score; items[r.id].aiReasoning = r.reasoning; } });
      const relevantItems = items.filter(item => item.aiScore > 20).sort((a,b)=>b.aiScore-a.aiScore);
      return relevantItems.slice(0, searchConfig.topN);
    }
  } catch (error) {
    log(`  AI ranking failed: ${error.message}`);
  }
  return [];
}

// ═══════════════════════════════════════════════════════════
// EMAIL SENDING (Google Apps Script style)
// ═══════════════════════════════════════════════════════════
async function sendEmail(unicornDeals) {
  if (unicornDeals.length === 0) { log('No unicorn deals to send'); return; }

  log(`\n📧 Sending email with ${unicornDeals.length} unicorn deal(s)...`);

  let emailBody = `<h1>🦄 Unicorn eBay Deals Found!</h1><p>Found ${unicornDeals.length} exceptional deals</p>`;
  unicornDeals.forEach((deal, idx) => {
    const minsLeft = parseTimeLeft(deal.item.timeLeft);
    const isUrgent = minsLeft && minsLeft <= deal.searchConfig.urgentHours * 60;
    const priceNumeric = extractPrice(deal.item.price);
    const discount = deal.searchConfig.expectedPrice && priceNumeric ? Math.round(((deal.searchConfig.expectedPrice - priceNumeric)/deal.searchConfig.expectedPrice)*100) : 0;
    emailBody += `
      <div style="border:3px solid ${isUrgent?'#f44336':'#4caf50'}; padding:15px; margin:15px;">
        <h2>#${idx+1} ${deal.item.title}</h2>
        <p>Price: ${deal.item.price} ${discount>0?`(${discount}% OFF)`:''}</p>
        <p>Condition: ${deal.item.condition}</p>
        <p>Shipping: ${deal.item.shipping}</p>
        <p>Location: ${deal.item.distance}</p>
        <p>Seller Rating: ${deal.item.sellerRating}</p>
        <p>${deal.item.isAuction?`Bids: ${deal.item.bidCount} | Time Left: ${deal.item.timeLeft}`:'Buy It Now'}</p>
        <p>AI Score: ${deal.item.aiScore}/100</p>
        <p>🤖 AI Analysis: ${deal.item.aiReasoning}</p>
        ${deal.item.img?`<img src="${deal.item.img}" style="max-width:300px;">`:''}
        <p><a href="${deal.item.link}">View on eBay →</a></p>
      </div>`;
  });

  // Google Apps Script style sending
  try {
    const { GoogleAppsScript } = require('google-apps-script'); // pseudo-import for context
    // In actual GAS, you would use MailApp.sendEmail directly
    MailApp.sendEmail({
      to: CONFIG.recipientEmail,
      subject: `🦄 ${unicornDeals.length} Unicorn Deal${unicornDeals.length>1?'s':''} Found!`,
      htmlBody: emailBody
    });
    log('✅ Email sent successfully!');
  } catch (error) {
    log(`❌ Email error: ${error.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════
async function main() {
  log('🤖 eBay Deal Monitor Starting...');
  log(`Scan time: ${new Date().toLocaleString('en-AU', { timeZone:'Australia/Adelaide' })}`);
  log(`Searching for ${CONFIG.searches.length} items`);

  try { validateConfig(); log('✅ Configuration validated'); }
  catch(e){ log(`❌ Config error: ${e.message}`); saveLog(); process.exit(1); }

  const unicornDeals = [];
  const allResults = [];
  for (let i=0; i<CONFIG.searches.length; i++) {
    const searchConfig = CONFIG.searches[i];
    try {
      const topItems = await scrapeEbay(searchConfig);
      if(topItems.length>0){
        topItems.forEach(item=>allResults.push({item, searchConfig}));
        const unicorns = topItems.filter(item=>item.aiScore>=searchConfig.unicornThreshold);
        unicorns.forEach(item=>unicornDeals.push({item, searchConfig}));
      }
      if(i<CONFIG.searches.length-1) await delay(5000);
    } catch(e){ log(`❌ Error searching "${searchConfig.name}": ${e.message}`); }
  }

  log(`Unicorn deals found: ${unicornDeals.length}`);
  if(unicornDeals.length>0) await sendEmail(unicornDeals);
  saveLog();
  log('✅ Monitoring complete!');
}

// Run
main().catch(e=>{ log(`💥 Fatal error: ${e.message}`); saveLog(); process.exit(1); });
