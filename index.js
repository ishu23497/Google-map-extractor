const puppeteer = require('puppeteer');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const readline = require('readline');
require('dotenv').config();

// BASE CONFIGURATION
const CONFIG = {
    // searchQuery will be set at runtime
    maxResults: 20,
    batchSize: 20,
    headless: false,
    outputFile: 'google_maps_data.csv',
    pdfFile: 'google_maps_summary.pdf'
};

const delay = (ms) => new Promise(res => setTimeout(res, ms));

function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

async function run() {
    console.log('--- Google Maps Business Extractor ---');

    // 1. GET USER INPUT
    let userInput = await askQuestion("Enter search query (example: Food shop in Agra): ");

    // Allow default if empty for easier testing if user just hits enter, 
    // but per requirements I should probably enforce it. 
    // However, for better UX let's enforce non-empty.
    while (!userInput || !userInput.trim()) {
        console.log('Error: Search query cannot be empty.');
        userInput = await askQuestion("Enter search query: ");
    }

    CONFIG.searchQuery = userInput.trim();

    console.log(`\nStarting Extractor...`);
    console.log(`Target: "${CONFIG.searchQuery}" (Max: ${CONFIG.maxResults})`);

    // 2. LAUNCH BROWSER
    const browser = await puppeteer.launch({
        headless: CONFIG.headless,
        args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox'],
        defaultViewport: null
    });

    const page = await browser.newPage();
    let extractedData = [];

    try {
        // --- PHASE 1: COLLECT URLs ---
        console.log('\n--- PHASE 1: Collecting Business URLs ---');
        await page.goto('https://www.google.com/maps?hl=en', { waitUntil: 'networkidle2' });

        const searchBoxSelector = '#searchboxinput';
        await page.waitForSelector(searchBoxSelector);

        // Type the user-provided query
        await page.type(searchBoxSelector, CONFIG.searchQuery);
        await page.keyboard.press('Enter');

        const feedSelector = 'div[role="feed"]';
        try {
            await page.waitForSelector(feedSelector, { timeout: 15000 });
            console.log('Search results list loaded. Scrolling...');
        } catch (e) {
            console.error('Error: Could not find the results list.');
            throw e;
        }

        const businessUrls = await collectUrls(page, feedSelector, CONFIG.maxResults);
        console.log(`\nCollection complete. Found ${businessUrls.length} unique URLs.`);

        // --- PHASE 2: BATCH PROCESSING ---
        console.log(`\n--- PHASE 2: Processing in Batches of ${CONFIG.batchSize} ---`);

        for (let i = 0; i < businessUrls.length; i += CONFIG.batchSize) {
            const batch = businessUrls.slice(i, i + CONFIG.batchSize);
            console.log(`\nProcessing Batch ${Math.floor(i / CONFIG.batchSize) + 1} (${batch.length} items)...`);

            for (let j = 0; j < batch.length; j++) {
                const url = batch[j];
                const globalIndex = i + j + 1;
                console.log(`[${globalIndex}/${businessUrls.length}] Visiting: ${url}`);

                try {
                    // Navigate Directly
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

                    // Wait for main content (flexible)
                    try {
                        await page.waitForSelector('h1', { timeout: 8000 });
                    } catch (e) {
                        console.log('  -> H1 timeout, attempting extraction anyway...');
                    }

                    // Anti-throttle delay
                    await delay(3000);

                    const data = await extractDetails(page, url);

                    if (data && data.name && data.name !== 'Google Maps') {
                        console.log(`  -> Extracted: ${data.name}`);
                        extractedData.push(data);
                    } else {
                        console.log('  -> Skipped (Invalid data/Not a business)');
                    }

                } catch (err) {
                    console.error(`  -> Error: ${err.message}`);
                }
            }

            if (i + CONFIG.batchSize < businessUrls.length) {
                console.log(`Batch complete. Resting for 10 seconds...`);
                await delay(10000);
            }
        }

        // --- PHASE 3: OUTPUT ---
        if (extractedData.length > 0) {
            await writeToCsv(extractedData);
            await saveToPdf(browser, extractedData);
            console.log(`\n✅ COMPLETION: Successfully saved ${extractedData.length} records.`);
            await sendTelegramReport(extractedData.length);
        } else {
            console.log('\n❌ No data extracted.');
        }

    } catch (error) {
        console.error('Fatal Error:', error);
    } finally {
        await browser.close();
    }
}

// SCROLL & COLLECT URLs
async function collectUrls(page, feedSelector, maxItems) {
    let urls = new Set();

    await page.evaluate(async (selector, max) => {
        const container = document.querySelector(selector);
        if (!container) return;

        let retries = 0;
        let distance = 800;

        while (true) {
            const sh = container.scrollHeight;
            container.scrollBy(0, distance);

            // Wait for load
            await new Promise(r => setTimeout(r, 1500));

            const count = document.querySelectorAll('a[href*="/maps/place/"]').length;

            if (count >= max) break;

            // End detection
            if (container.scrollHeight === sh) {
                retries++;
                if (retries === 2) container.scrollBy(0, -300); // Wiggle
                if (retries > 8) break; // Hard stop
            } else {
                retries = 0;
            }
        }
    }, feedSelector, maxItems);

    const hrefs = await page.$$eval('a[href*="/maps/place/"]', links => links.map(l => l.href));
    hrefs.forEach(h => urls.add(h));

    return Array.from(urls).slice(0, maxItems);
}

// EXTRACT DETAILS
async function extractDetails(page, url) {
    return await page.evaluate((currentUrl) => {
        const cleanText = (str) => str ? str.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
        const removeLabel = (str, regex) => str.replace(regex, '').trim();

        // Safe Selectors
        let name = document.querySelector('h1')?.innerText || '';
        name = cleanText(name);
        if (!name) return null;

        // Rating
        const ratingEl = document.querySelector('div[role="main"] span[aria-label*="stars"]');
        const rating = ratingEl ? ratingEl.getAttribute('aria-label').split(' ')[0] : 'N/A';

        // Reviews
        const reviewsEl = document.querySelector('div[role="main"] button[aria-label*="reviews"]');
        const reviewsMatch = reviewsEl ? reviewsEl.getAttribute('aria-label').match(/([0-9,]+)/) : null;
        const reviews = reviewsMatch ? reviewsMatch[1].replace(/,/g, '') : '0';

        let address = 'N/A';
        let phone = 'N/A';
        let website = 'N/A';

        // Scan ALL Text/Buttons/Links
        const elements = Array.from(document.querySelectorAll('div[role="main"] button, div[role="main"] a, div[role="main"] div[data-item-id]'));

        elements.forEach(el => {
            const aria = el.getAttribute('aria-label') || '';
            const text = el.innerText || '';
            const id = el.getAttribute('data-item-id') || '';
            const href = el.href || '';

            const content = cleanText(aria || text);

            if (id === 'address' || content.includes('Address:')) {
                const possibleAddr = removeLabel(content, /^Address:?\s*/i);
                if (possibleAddr.length > 5) address = possibleAddr;
            }

            if (id.startsWith('phone') || content.includes('Phone:')) {
                const possiblePhone = removeLabel(content, /^Phone:?\s*/i);
                if (possiblePhone.match(/[\d\+\-\(\)\s]{5,}/)) phone = possiblePhone;
            }

            if (id === 'authority' || content.includes('Website:')) {
                if (el.tagName === 'A' && href) website = href;
                else website = removeLabel(content, /^Website:?\s*/i);
            }
        });

        // Fallback for Website
        if (website === 'N/A') {
            const webLink = Array.from(document.querySelectorAll('a[href^="http"]'))
                .find(a => a.getAttribute('data-item-id') === 'authority');
            if (webLink) website = cleanText(webLink.href);
        }

        return {
            name,
            phone,
            address,
            website,
            rating,
            reviews,
            url: currentUrl
        };
    }, url);
}

// HELPERS
async function writeToCsv(data) {
    const csvWriter = createCsvWriter({
        path: CONFIG.outputFile,
        header: [
            { id: 'name', title: 'Business Name' },
            { id: 'phone', title: 'Phone Number' },
            { id: 'address', title: 'Full Address' },
            { id: 'website', title: 'Website' },
            { id: 'rating', title: 'Rating' },
            { id: 'reviews', title: 'Total Reviews' },
            { id: 'url', title: 'Google Maps URL' }
        ]
    });
    await csvWriter.writeRecords(data);
}

async function saveToPdf(browser, data) {
    try {
        const page = await browser.newPage();
        const htmlContent = `
        <html><head><style>
            body { font-family: sans-serif; padding: 20px; font-size: 10px; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #ccc; padding: 5px; }
            th { background: #eee; }
        </style></head>
        <body>
            <h2>Extraction Report</h2>
            <p><strong>Query:</strong> ${CONFIG.searchQuery}</p>
            <table>
                <thead><tr><th>Name</th><th>Phone</th><th>Address</th><th>Rating</th></tr></thead>
                <tbody>${data.slice(0, 100).map(d => `
                <tr><td>${d.name}</td><td>${d.phone}</td><td>${d.address}</td><td>${d.rating}</td></tr>`).join('')}
                </tbody>
            </table>
        </body></html>`;
        await page.setContent(htmlContent);
        await page.pdf({ path: CONFIG.pdfFile, format: 'A4' });
        await page.close();
    } catch (e) { console.error('PDF Error:', e.message); }
}

async function sendTelegramReport(count) {
    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('⚠️  Telegram credentials not found. Skipping notification.');
        return;
    }
    console.log('\n--- Sending Telegram Notification ---');
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
        await axios.post(`${url}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: `🚀 *Extraction Completed*\n🔍 *Query:* ${CONFIG.searchQuery}\n📊 *Total Businesses:* ${count}\n🕒 *Time:* ${new Date().toLocaleString()}`,
            parse_mode: 'Markdown'
        });
        console.log('✅ Telegram status message sent.');

        await sendTelegramFile(CONFIG.outputFile, 'CSV Data');
        if (fs.existsSync(CONFIG.pdfFile)) await sendTelegramFile(CONFIG.pdfFile, 'PDF Report');
        console.log('✅ Sent to Telegram.');
    } catch (e) { console.error('Telegram Error:', e.message); }
}

async function sendTelegramFile(path, caption) {
    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    try {
        if (!fs.existsSync(path)) return;
        const form = new FormData();
        form.append('chat_id', TELEGRAM_CHAT_ID);
        form.append('caption', caption);
        form.append('document', fs.createReadStream(path));
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, form, { headers: form.getHeaders() });
    } catch (e) { }
}

run();
