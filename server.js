// server.js

import express from 'express';
import puppeteer from 'puppeteer';
// FIX: Use createRequire to reliably import the CommonJS 'robots-txt-parser' module.
// This is the most robust way to handle this specific library's packaging.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// The 'robots-txt-parser' library uses a default export for its class.
// We must import it without using destructuring braces {}.
const RobotsTxtParser = require('robots-txt-parser');

import cors from 'cors';

const app = express();
const port = 3001;

app.use(cors()); // Enable Cross-Origin Resource Sharing for your frontend
app.use(express.json()); // Enable parsing of JSON request bodies

// A simple in-memory cache to respect rate-limiting and avoid re-scraping the same URL too quickly
const cache = new Map();

// You would ideally use a rotating proxy service for IP rotation.
// This is a placeholder for where you would configure it.
const getProxy = () => {
    // In a real implementation, this function would return a new proxy URL
    // from a list of available proxies.
    // e.g., return 'http://user:pass@proxyserver:8080';
    return null;
};

app.post('/scrape', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const urlObject = new URL(url);
        const robotsUrl = `${urlObject.protocol}//${urlObject.hostname}/robots.txt`;

        // 1. Respect robots.txt
        // FIX: Call the factory function to get a parser instance (not a constructor).
        const robotsParser = RobotsTxtParser();
        await robotsParser.fetch(robotsUrl);
        if (!robotsParser.canCrawl(url, 'MyScraperBot/1.0')) {
            return res.status(403).json({ error: "Scraping is disallowed by this site's robots.txt" });
        }

        // 2. Respect Rate-Limiting (simple cache)
        if (cache.has(url)) {
            console.log('Returning cached data for:', url);
            return res.json(cache.get(url));
        }

        // 3. Configure Puppeteer for containerized environment
        const proxy = getProxy();
        // Add required arguments for running in a containerized environment like Render
        const puppeteerArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
        if (proxy) {
            puppeteerArgs.push(`--proxy-server=${proxy}`);
        }

        // Configure Chrome executable path for deployment environments
        const launchOptions = { 
            headless: true, 
            args: puppeteerArgs
        };
        
        // Handle Chrome executable path for Render and other production environments
        if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
            console.log('Production environment detected, configuring Chrome...');
            
            // Try environment variable first (set by render.yaml)
            if (process.env.PUPPETEER_EXECUTABLE_PATH) {
                console.log(`Trying PUPPETEER_EXECUTABLE_PATH: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
                try {
                    const fs = await import('fs');
                    if (fs.existsSync && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
                        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
                        console.log(`Using Chrome from env var: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
                    }
                } catch (e) {
                    console.log('PUPPETEER_EXECUTABLE_PATH not accessible');
                }
            }
            
            // If not found, try Puppeteer cache directory
            if (!launchOptions.executablePath) {
                const cacheDir = process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer';
                console.log(`Checking Puppeteer cache directory: ${cacheDir}`);
                
                try {
                    const fs = await import('fs');
                    const path = await import('path');
                    
                    // Look for Chrome in the cache directory
                    if (fs.existsSync && fs.existsSync(cacheDir)) {
                        const chromeDir = path.join(cacheDir, 'chrome');
                        if (fs.existsSync(chromeDir)) {
                            // Find the version directory
                            const versions = fs.readdirSync(chromeDir);
                            console.log(`Found Chrome versions: ${versions.join(', ')}`);
                            
                            for (const version of versions) {
                                const chromePath = path.join(chromeDir, version, 'chrome-linux64', 'chrome');
                                if (fs.existsSync(chromePath)) {
                                    launchOptions.executablePath = chromePath;
                                    console.log(`Using Chrome from cache: ${chromePath}`);
                                    break;
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.log('Error accessing Puppeteer cache:', e.message);
                }
            }
            
            // Fallback to system Chrome paths
            if (!launchOptions.executablePath) {
                console.log('Trying system Chrome paths...');
                const chromePaths = [
                    '/usr/bin/google-chrome-stable',
                    '/usr/bin/google-chrome',
                    '/usr/bin/chromium-browser',
                    '/usr/bin/chromium',
                    process.env.CHROME_BIN
                ].filter(Boolean);
                
                for (const chromePath of chromePaths) {
                    try {
                        const fs = await import('fs');
                        if (fs.existsSync && fs.existsSync(chromePath)) {
                            launchOptions.executablePath = chromePath;
                            console.log(`Using system Chrome: ${chromePath}`);
                            break;
                        }
                    } catch (e) {
                        // Continue to next path
                    }
                }
            }
            
            if (!launchOptions.executablePath) {
                console.log('No Chrome executable found, letting Puppeteer handle it...');
            }
        }
        
        const browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        await page.setUserAgent('MyScraperBot/1.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
        await page.goto(url, { waitUntil: 'networkidle2' });

        // --- SCRAPING LOGIC ---
        // This part is specific to the website's HTML structure.
        // These selectors are examples for Amazon and may need to be adjusted.
        const productData = await page.evaluate(() => {
            // Find the main product image
            const imageEl = document.querySelector('#landingImage, #imgTagWrapperId img');
            const imageUrl = imageEl ? imageEl.src : null;

            // Find product text details
            const title = document.querySelector('#productTitle')?.innerText.trim();
            const highlights = Array.from(document.querySelectorAll('#feature-bullets ul li .a-list-item'))
                                    .map(el => el.innerText.trim()).join('\n');
            
            const description = [title, highlights].filter(Boolean).join('\n\n');

            return { description, imageUrl };
        });

        await browser.close();
        
        if (!productData.imageUrl || !productData.description) {
            throw new Error('Could not find product details on the page. Selectors might be outdated.');
        }
        
        // Fetch the image to determine its MIME type
        const imageResponse = await fetch(productData.imageUrl);
        const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

        const finalResponse = {
            description: productData.description,
            imageUrl: productData.imageUrl,
            mimeType: mimeType
        };
        
        // Cache the successful response
        cache.set(url, finalResponse);

        res.json(finalResponse);

    } catch (error) {
        console.error('Scraping failed:', error);
        res.status(500).json({ error: `Failed to scrape the URL. ${error.message}` });
    }
});

app.listen(port, () => {
    console.log(`Scraping server listening at http://localhost:${port}`);
});