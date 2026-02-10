const fetch = require('node-fetch');
const fs = require('fs');

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  // API Keys from environment variables
  scraperApiKey: process.env.SCRAPER_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  sendgridApiKey: process.env.SENDGRID_API_KEY,
  recipientEmail: process.env.RECIPIENT_EMAIL,
  
  // 5 Different Item Searches
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
  const required = ['scraperApiKey', 'geminiApiKey', 'sendgridApiKey', 'recipientEmail'];
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
      
      if (!res.ok) {
        throw new Error(`ScraperAPI ${res.status}: ${res.statusText}`);
      }
      
      return await res.text();
    } catch (error) {
      log(`  Fetch attempt ${i + 1}/${retries} failed: ${error.message}`);
      if (i === retries - 1) throw error;
      await delay(5000 * (i + 1)); // Exponential backoff
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
            generationConfig: {
              temperature: temperature,
              maxOutputTokens: 8000,
            }
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

RANKING CRITERIA (in priority order):
1. **Relevance to "${searchTerm}"** - must actually match what user is looking for
2. **AUCTION TIMING (CRITICAL FOR URGENCY):**
   - Auctions ending in <${urgentHours}h with 0-2 bids = URGENT OPPORTUNITY (major score boost +20)
   - Auctions ending in ${urgentHours}-${parseFloat(urgentHours)*2}h with low bids = great opportunity (score boost +10)
   - Auctions ending soon with many bids = likely to increase (slight penalty -5)
   - Auctions with 1+ days remaining = valuable but less urgent (neutral)
   - Buy It Now = stable price, no time pressure (neutral)
3. **Price vs. expected value** - lower is better if quality is good
4. **Condition** - new/mint > excellent > very good > good > acceptable
5. **Bid activity** - fewer bids on auctions = better deal potential
6. **Shipping cost** - free > low cost > expensive
7. **Seller rating** - 98%+ is excellent, 95-98% is good, <95% is risky

SCORING STRATEGY:
- Start with base score of 50
- Highly relevant match: +20 points
- Price well below expected value: +15 points
- Ending soon (<${urgentHours}h) with low bids: +20 points (URGENT)
- Ending soon (${urgentHours}-${parseFloat(urgentHours)*2}h) with low bids: +10 points
- Excellent condition (new/mint): +10 points
- Free shipping: +5 points
- Seller 98%+: +5 points
- Not relevant to search: score should be <30

OUTPUT FORMAT (strict JSON):
{
  "rankings": [
    {
      "id": 0,
      "rank": 1,
      "score": 95,
      "reasoning": "Brief explanation of why this is a great deal"
    }
  ]
}

Rules:
- Filter out items NOT relevant to "${searchTerm}" (score them <30)
- Score range: 0-100 (100 = best value)
- Sort by score descending (best deals first)
- Emphasize auction timing in reasoning for time-sensitive deals
- Be concise (1-2 sentences max)
- ONLY return valid JSON, no other text`;

  const response = await callGeminiAPI(prompt, 0.2);
  let jsonStr = response.trim();
  
  // Extract JSON from response
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
  
  if (searchConfig.auctionOnly) {
    ebayUrl += '&LH_Auction=1';
  }
  
  log(`  URL: ${ebayUrl}`);
  
  const html = await fetchWithDelay(ebayUrl);
  log(`  HTML length: ${html.length.toLocaleString()} chars`);
  
  const { JSDOM } = require('jsdom');
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

    let timeLeft = 'N/A';
    let bidCount = 0;
    let isAuction = false;

    const timeEl = li.querySelector('.s-item__time-left, .s-item__timeLeft');
    if (timeEl) {
      timeLeft = timeEl.textContent.trim();
      isAuction = true;
    }

    const bidEl = li.querySelector('.s-item__bids, [class*="bid"]');
    if (bidEl) {
      const bidText = bidEl.textContent.trim();
      const bidMatch = bidText.match(/(\d+)\s*bid/i);
      if (bidMatch) bidCount = parseInt(bidMatch[1]);
      if (bidText.toLowerCase().includes('bid')) isAuction = true;
    }

    const sellerEl = li.querySelector('.s-item__seller-info');
    let sellerRating = 'N/A';
    if (sellerEl) {
      const ratingMatch = sellerEl.textContent.match(/([\d.]+)%/);
      if (ratingMatch) sellerRating = ratingMatch[1] + '%';
    }

    // Skip invalid items
    if (title === 'N/A' || 
        price === 'N/A' || 
        !link.includes('itm/') || 
        title.toLowerCase().includes('shop on ebay')) {
      return;
    }

    items.push({
      title, price, condition, shipping, distance: dist, link, img: imgSrc,
      timeLeft, bidCount, isAuction, sellerRating,
      aiScore: 0,
      aiReasoning: ''
    });
  });

  log(`  Extracted ${items.length} valid items`);

  if (items.length === 0) {
    log(`  ⚠️ No items found for "${searchConfig.name}"`);
    return [];
  }

  // AI Ranking
  log(`  Running AI analysis...`);
  const urgentThresholdMins = searchConfig.urgentHours * 60;
  
  try {
    const rankings = await rankItemsWithGemini(items, searchConfig.term, searchConfig.expectedPrice, urgentThresholdMins);

    if (rankings.length > 0) {
      rankings.forEach(ranking => {
        if (items[ranking.id]) {
          items[ranking.id].aiScore = ranking.score;
          items[ranking.id].aiReasoning = ranking.reasoning;
        }
      });

      const relevantItems = items.filter(item => item.aiScore > 20);
      relevantItems.sort((a, b) => b.aiScore - a.aiScore);

      const topItems = relevantItems.slice(0, searchConfig.topN);
      
      if (topItems.length > 0) {
        log(`  ✅ Top item: ${topItems[0].title.substring(0, 60)}... (Score: ${topItems[0].aiScore})`);
      }

      return topItems;
    } else {
      log(`  ⚠️ AI ranking returned no results`);
      return [];
    }
  } catch (error) {
    log(`  ❌ AI ranking failed: ${error.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// EMAIL SENDING
// ═══════════════════════════════════════════════════════════
async function sendEmail(unicornDeals) {
  if (unicornDeals.length === 0) {
    log('No unicorn deals to send');
    return;
  }

  log(`\n📧 Sending email with ${unicornDeals.length} unicorn deal(s)...`);

  let emailBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
          max-width: 800px; 
          margin: 0 auto; 
          background: #f5f5f5;
          padding: 20px;
        }
        .header { 
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
          color: white; 
          padding: 30px; 
          text-align: center; 
          border-radius: 12px 12px 0 0; 
          margin: 0;
        }
        .header h1 { margin: 0 0 10px; font-size: 32px; }
        .header p { margin: 0; opacity: 0.9; }
        .deal { 
          border: 3px solid #4caf50; 
          padding: 25px; 
          margin: 20px 0; 
          border-radius: 12px; 
          background: white;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        .urgent { 
          border-color: #f44336; 
          background: #fff5f5;
          animation: pulse-border 2s infinite;
        }
        @keyframes pulse-border {
          0%, 100% { border-color: #f44336; }
          50% { border-color: #ff6659; }
        }
        .deal h2 { 
          margin: 0 0 15px; 
          color: #333; 
          font-size: 22px;
          line-height: 1.4;
        }
        .badges { margin: 10px 0; }
        .price { 
          font-size: 32px; 
          color: #c62828; 
          font-weight: bold; 
          margin: 15px 0; 
        }
        .score { 
          background: #4285f4; 
          color: white; 
          padding: 6px 14px; 
          border-radius: 6px; 
          display: inline-block; 
          font-weight: bold; 
          margin: 5px 5px 5px 0;
          font-size: 14px;
        }
        .urgent-badge { 
          background: #f44336; 
          color: white; 
          padding: 6px 14px; 
          border-radius: 6px; 
          display: inline-block; 
          font-weight: bold; 
          margin: 5px 5px 5px 0;
          font-size: 14px;
        }
        .discount-badge {
          background: #4caf50;
          color: white;
          padding: 6px 14px;
          border-radius: 6px;
          display: inline-block;
          font-weight: bold;
          margin: 5px 5px 5px 0;
          font-size: 14px;
        }
        .ai-reasoning { 
          background: #e8f0fe; 
          padding: 15px; 
          border-radius: 8px; 
          margin: 15px 0; 
          border-left: 4px solid #4285f4;
          font-size: 15px;
          line-height: 1.6;
        }
        .meta { 
          color: #666; 
          font-size: 14px; 
          margin: 8px 0;
          line-height: 1.5;
        }
        .meta strong { color: #333; }
        .cta-button { 
          background: #3665f3; 
          color: white !important; 
          padding: 14px 28px; 
          text-decoration: none; 
          border-radius: 8px; 
          display: inline-block; 
          font-weight: bold; 
          margin: 15px 0;
          font-size: 16px;
        }
        .cta-button:hover {
          background: #2451cc;
        }
        img { 
          max-width: 100%; 
          height: auto;
          border-radius: 8px; 
          margin: 15px 0;
          display: block;
        }
        .footer {
          text-align: center;
          color: #999;
          padding: 20px;
          font-size: 12px;
          background: white;
          border-radius: 0 0 12px 12px;
          margin-top: 0;
        }
        @media (max-width: 600px) {
          body { padding: 10px; }
          .header { padding: 20px; }
          .header h1 { font-size: 24px; }
          .deal { padding: 15px; }
          .price { font-size: 24px; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🦄 Unicorn eBay Deals Found!</h1>
        <p>Found ${unicornDeals.length} exceptional deal${unicornDeals.length > 1 ? 's' : ''} matching your criteria</p>
      </div>
  `;
  
  unicornDeals.forEach((deal, index) => {
    const minsLeft = parseTimeLeft(deal.item.timeLeft);
    const isUrgent = minsLeft && minsLeft <= deal.searchConfig.urgentHours * 60;
    const dealClass = isUrgent ? 'deal urgent' : 'deal';
    
    const urgencyBadge = isUrgent 
      ? `<span class="urgent-badge">⏰ ENDING IN ${deal.item.timeLeft.toUpperCase()}!</span>` 
      : '';
    
    const priceNumeric = extractPrice(deal.item.price);
    const discount = deal.searchConfig.expectedPrice && priceNumeric 
      ? Math.round(((deal.searchConfig.expectedPrice - priceNumeric) / deal.searchConfig.expectedPrice) * 100)
      : 0;
    const discountBadge = discount > 0 
      ? `<span class="discount-badge">💰 ${discount}% OFF</span>`
      : '';

    emailBody += `
      <div class="${dealClass}">
        <h2>#${index + 1} ${deal.item.title}</h2>
        <div class="badges">
          ${urgencyBadge}
          <span class="score">AI Score: ${deal.item.aiScore}/100</span>
          ${discountBadge}
        </div>
        
        <div class="price">${deal.item.price}</div>
        
        <div class="meta"><strong>Search Category:</strong> ${deal.searchConfig.name}</div>
        <div class="meta"><strong>Condition:</strong> ${deal.item.condition}</div>
        ${deal.item.isAuction 
          ? `<div class="meta"><strong>🔨 Bids:</strong> ${deal.item.bidCount || 0} | <strong>Time Left:</strong> ${deal.item.timeLeft}</div>` 
          : '<div class="meta">💰 Buy It Now</div>'}
        <div class="meta"><strong>Shipping:</strong> ${deal.item.shipping}</div>
        <div class="meta"><strong>Location:</strong> ${deal.item.distance}</div>
        <div class="meta"><strong>Seller Rating:</strong> ${deal.item.sellerRating}</div>
        
        <div class="ai-reasoning">
          <strong>🤖 AI Analysis:</strong> ${deal.item.aiReasoning}
        </div>
        
        ${deal.item.img ? `<img src="${deal.item.img}" alt="${deal.item.title.replace(/"/g, '&quot;')}">` : ''}
        
        <a href="${deal.item.link}" class="cta-button">View on eBay →</a>
      </div>
    `;
  });

  const scanTime = new Date().toLocaleString('en-AU', { 
    timeZone: 'Australia/Adelaide',
    dateStyle: 'full',
    timeStyle: 'short'
  });

  emailBody += `
      <div class="footer">
        <p><strong>eBay Deal Monitor</strong></p>
        <p>Scanned at: ${scanTime}</p>
        <p>Next scan in 48 hours</p>
      </div>
    </body>
    </html>
  `;

  try {
    const sgMail = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.sendgridApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        personalizations: [{
          to: [{ email: CONFIG.recipientEmail }]
        }],
        from: { 
          email: CONFIG.recipientEmail,
          name: 'eBay Deal Monitor'
        },
        subject: `🦄 ${unicornDeals.length} Unicorn Deal${unicornDeals.length > 1 ? 's' : ''} Found!`,
        content: [{
          type: 'text/html',
          value: emailBody
        }]
      })
    });

    if (sgMail.ok) {
      log('✅ Email sent successfully!');
    } else {
      const errorText = await sgMail.text();
      log(`❌ Email failed (${sgMail.status}): ${errorText}`);
      throw new Error(`Failed to send email: ${sgMail.status} ${errorText}`);
    }
  } catch (error) {
    log(`❌ Email error: ${error.message}`);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════
async function main() {
  log('═══════════════════════════════════════════════════════════');
  log('🤖 eBay Deal Monitor Starting...');
  log(`Scan time: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' })}`);
  log(`Searching for ${CONFIG.searches.length} different items`);
  log('═══════════════════════════════════════════════════════════');
  
  // Validate configuration
  try {
    validateConfig();
    log('✅ Configuration validated');
  } catch (error) {
    log(`❌ Configuration error: ${error.message}`);
    saveLog();
    process.exit(1);
  }
  
  const unicornDeals = [];
  const allResults = [];
  let successfulSearches = 0;
  let failedSearches = 0;

  for (let i = 0; i < CONFIG.searches.length; i++) {
    const searchConfig = CONFIG.searches[i];
    
    try {
      const topItems = await scrapeEbay(searchConfig);
      
      if (topItems.length > 0) {
        successfulSearches++;
        
        // Store all results
        topItems.forEach(item => {
          allResults.push({ item, searchConfig });
        });
        
        // Find unicorn deals (above threshold)
        const unicorns = topItems.filter(item => item.aiScore >= searchConfig.unicornThreshold);
        
        if (unicorns.length > 0) {
          log(`  🦄 ${unicorns.length} UNICORN(S) FOUND for "${searchConfig.name}"!`);
          unicorns.forEach(item => {
            log(`     - ${item.title.substring(0, 60)}... (Score: ${item.aiScore})`);
            unicornDeals.push({ item, searchConfig });
          });
        } else {
          log(`  No unicorns this time (best score: ${topItems[0]?.aiScore || 'N/A'})`);
        }
      } else {
        failedSearches++;
        log(`  ⚠️ No items found for "${searchConfig.name}"`);
      }
      
      // Delay between searches to avoid rate limits
      if (i < CONFIG.searches.length - 1) {
        log(`  Waiting 5 seconds before next search...`);
        await delay(5000);
      }
      
    } catch (error) {
      failedSearches++;
      log(`❌ Error searching for "${searchConfig.name}": ${error.message}`);
      log(`   Stack: ${error.stack}`);
    }
  }

  log('\n═══════════════════════════════════════════════════════════');
  log('📊 SCAN SUMMARY:');
  log(`Successful searches: ${successfulSearches}/${CONFIG.searches.length}`);
  log(`Failed searches: ${failedSearches}/${CONFIG.searches.length}`);
  log(`Total items analyzed: ${allResults.length}`);
  log(`Unicorn deals found: ${unicornDeals.length}`);
  log('═══════════════════════════════════════════════════════════');

  if (unicornDeals.length > 0) {
    try {
      await sendEmail(unicornDeals);
    } catch (error) {
      log(`❌ Failed to send email: ${error.message}`);
    }
  } else {
    log('\n💭 No unicorn deals found this time. Will check again in 48 hours.');
  }

  saveLog();
  log('\n✅ Monitoring complete!');
  
  // Exit with error code if all searches failed
  if (failedSearches === CONFIG.searches.length) {
    log('❌ All searches failed - exiting with error');
    process.exit(1);
  }
}

// Run the scanner
main().catch(error => {
  log(`💥 Fatal error: ${error.message}`);
  log(error.stack);
  saveLog();
  process.exit(1);
});