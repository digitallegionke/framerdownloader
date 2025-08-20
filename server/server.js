const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const cheerio = require('cheerio');
const cors = require('cors');
const archiver = require('archiver');
const app = express();

// --- Global Error Handlers Start ---
process.on('uncaughtException', (err, origin) => {
  console.error(`Caught exception: ${err}\n` + `Exception origin: ${origin}`);
  // Optionally, perform cleanup and exit gracefully
  // process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Optionally, perform cleanup and exit gracefully
  // process.exit(1);
});
// --- Global Error Handlers End ---

app.use(cors());
app.use(express.json());

// Use /tmp directory for Vercel serverless environment
const TMP_DOWNLOAD_DIR = '/tmp/downloads';

// Ensure the tmp directory exists
fs.ensureDirSync(TMP_DOWNLOAD_DIR);

app.post('/api/download', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    // --- SSRF Prevention Start ---
    try {
        const parsedUrl = new URL(url);
        if (['localhost', '127.0.0.1'].includes(parsedUrl.hostname)) {
            return res.status(400).json({ error: 'Fetching from localhost is not allowed.' });
        }
    } catch (e) {
        // Handle invalid URL format early
        return res.status(400).json({ error: 'Invalid URL format' });
    }
    // --- SSRF Prevention End ---

    // Use the /tmp directory for downloads
    const timestamp = Date.now().toString();
    const downloadDir = path.join(TMP_DOWNLOAD_DIR, timestamp);
    let responseSent = false;
    // Set a timeout to ensure a response is always sent
    const timeout = setTimeout(() => {
        if (!responseSent) {
            responseSent = true;
            res.status(504).json({ error: 'Download process timed out. Please try again.' });
        }
    }, 60000); // 60 seconds

    try {
        console.log(`[${timestamp}] Starting download process for URL: ${url}`);
        
        // Validate URL format
        try {
            new URL(url);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid URL format' });
        }

        // Ensure the tmp directory exists
        await fs.ensureDir(downloadDir);
        console.log(`[${timestamp}] Directory created: ${downloadDir}`);

        // Fetch with timeout and better error handling
        console.log(`[${timestamp}] Attempting to fetch URL: ${url}`);
        let response;
        try {
            response = await fetch(url, {
                timeout: 30000, // 30 second timeout
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            console.log(`[${timestamp}] Fetch response status: ${response.status}`);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
        } catch (fetchError) {
            console.error(`[${timestamp}] Fetch error:`, fetchError);
            return res.status(500).json({ 
                error: `Failed to fetch URL: ${fetchError.message}`,
                details: fetchError.toString()
            });
        }

        // Try to get the response text
        let html;
        try {
            html = await response.text();
            console.log(`[${timestamp}] Successfully retrieved HTML content, length: ${html.length}`);
            
            if (!html || html.trim().length === 0) {
                throw new Error('Empty response received from server');
            }
        } catch (textError) {
            console.error(`[${timestamp}] Error getting response text:`, textError);
            return res.status(500).json({ 
                error: 'Failed to read response content',
                details: textError.toString()
            });
        }

        // Load HTML with cheerio
        console.log(`[${timestamp}] Parsing HTML with cheerio`);
        const $ = cheerio.load(html);
        console.log(`[${timestamp}] Cheerio loaded.`); // Log Cheerio load

        const downloadAsset = async (assetUrl, filePath) => {
            try {
                const assetRes = await fetch(assetUrl);
                if (!assetRes.ok) {
                    console.warn(`Failed to download asset: ${assetUrl} - ${assetRes.status}`);
                    return;
                }
                const buffer = await assetRes.buffer();
                await fs.writeFile(filePath, buffer);
            } catch (err) {
                console.error(`Error downloading ${assetUrl}: ${err}`);
            }
        };

        const assets = [];
        $('img').each((_, el) => assets.push({ url: $(el).attr('src'), type: 'image' }));
        $('link[rel="stylesheet"]').each((_, el) => assets.push({ url: $(el).attr('href'), type: 'css' }));
        $('script[src]').each((_, el) => assets.push({ url: $(el).attr('src'), type: 'js' }));
        console.log(`[${timestamp}] Found ${assets.length} potential assets.`); // Log asset count

        const uniqueAssets = new Map();
        assets.forEach(asset => {
            try {
                const resolvedUrl = new URL(asset.url, url).href;
                if (!uniqueAssets.has(resolvedUrl)) {
                    uniqueAssets.set(resolvedUrl, { url: resolvedUrl, type: asset.type });
                }
            } catch (e) {
                console.warn(`Invalid URL: ${asset.url}`);
            }
        });
        console.log(`[${timestamp}] Processing ${uniqueAssets.size} unique assets.`); // Log unique asset count

        const assetPromises = Array.from(uniqueAssets.values()).map(async (asset) => {
            let assetPath;
            const assetUrlObj = new URL(asset.url);
            const baseName = path.basename(assetUrlObj.pathname) || 'asset'; // Handle cases with no path name

            if (asset.type === 'image') {
                const imgDir = path.join(downloadDir, 'images');
                await fs.ensureDir(imgDir);
                assetPath = path.join(imgDir, baseName);
            } else if (asset.type === 'css') {
                const cssDir = path.join(downloadDir, 'css');
                await fs.ensureDir(cssDir);
                assetPath = path.join(cssDir, baseName);
            } else if (asset.type === 'js') {
                const jsDir = path.join(downloadDir, 'js');
                await fs.ensureDir(jsDir);
                assetPath = path.join(jsDir, baseName);
            } else {
                console.warn('Unknown asset type:', asset.type, asset.url);
                return;
            }
            await downloadAsset(asset.url, assetPath);
        });

        console.log(`[${timestamp}] Waiting for assets to download...`); // Log before Promise.all
        await Promise.all(assetPromises);
        console.log(`[${timestamp}] All assets downloaded.`); // Log after Promise.all

        const modifiedHtml = html.replace(/<div class="framer-badge.*?>.*?<\/div>/s, '');
        console.log(`[${timestamp}] Writing index.html...`); // Log before writing index.html
        await fs.writeFile(path.join(downloadDir, 'index.html'), modifiedHtml);
        console.log(`[${timestamp}] index.html written.`); // Log after writing index.html

        // Create a ZIP archive in the /tmp directory
        const zipFilename = `site-${timestamp}.zip`;
        const zipFilePath = path.join(TMP_DOWNLOAD_DIR, zipFilename);
        console.log(`[${timestamp}] Creating zip file: ${zipFilePath}`); // Log before zip
        const output = fs.createWriteStream(zipFilePath);
        const archiver = require('archiver')('zip', {
            zlib: { level: 9 }
        });

        // --- Error Handling for Archiving Start ---
        // Listen for errors on the output stream
        output.on('error', (err) => {
            console.error('Stream Error:', err);
            if (!responseSent) {
                responseSent = true;
                clearTimeout(timeout);
                res.status(500).json({ error: 'Failed to create zip file (stream error).' });
            }
            fs.unlink(zipFilePath).catch(unlinkErr => console.error('Error deleting partial zip:', unlinkErr));
        });

        // Listen for errors on the archiver instance
        archiver.on('error', (err) => {
            console.error('Archiver Error:', err);
            if (!responseSent) {
                responseSent = true;
                clearTimeout(timeout);
                res.status(500).json({ error: 'Failed to create zip file (archiver error).' });
            }
        });
        // --- Error Handling for Archiving End ---

        archiver.pipe(output);

        archiver.directory(downloadDir, false);
        archiver.finalize();

        output.on('close', () => {
            console.log(`[${timestamp}] Zip file ${zipFilePath} created successfully.`);
            if (!responseSent) {
                responseSent = true;
                clearTimeout(timeout);
                res.json({ success: true, message: 'Download complete!', zipFilePath: `/api/download/${zipFilename}` });
            }
        });

        output.on('end', () => {
            console.log('Zip file has been created and the stream has finished');
        });

    } catch (error) {
        const timestamp = Date.now(); // Use a local timestamp for error logging
        console.error(`[${timestamp}] Download error in catch block:`, error);
        if (downloadDir && fs.existsSync(downloadDir)) {
            await fs.remove(downloadDir).catch(err => console.error('Error cleaning up dir:', err));
        }
        if (!responseSent) {
            responseSent = true;
            clearTimeout(timeout);
            res.status(500).json({ error: error.message || 'An error occurred during download' });
        }
    }
});

app.get('/api/download/:filename', (req, res) => {
    const filename = req.params.filename;
    // Serve from the /tmp directory
    const filePath = path.join(TMP_DOWNLOAD_DIR, filename);

    if (fs.existsSync(filePath)) {
        res.download(filePath, filename, (err) => {
            if (err) {
                console.error("Error sending file:", err);
                // Don't try to remove the file if sending failed
                if (!res.headersSent) {
                    res.status(500).send("Error sending file!");
                }
            } else {
                // Clean up the zip file after successful download
                fs.unlink(filePath, (unlinkErr) => {
                    if (unlinkErr) {
                        console.error("Error deleting zip file:", unlinkErr);
                    } else {
                        console.log(`Zip file ${filePath} deleted successfully`);
                    }
                });
            }
        });
    } else {
        console.log(`File not found: ${filePath}`);
        res.status(404).send('File not found');
    }
});

// Export the app for Vercel
module.exports = app; 

// Start the server only if not in a Vercel environment
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5001;
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
} 