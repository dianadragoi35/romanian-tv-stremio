#!/usr/bin/env node

/**
 * Warmup Script for Pre-generating Channel Posters
 *
 * This script pre-generates all posters for Romanian TV channels.
 * Run this once (or periodically) before deploying the app.
 *
 * Usage: node warmup-posters.js
 */

const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

/* ---------------- CONSTANTS ---------------- */
const IPTV_CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const IPTV_STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';
const IPTV_LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';
const POSTERS_DIR = path.join(__dirname, 'posters');
const COUNTRY = 'RO';
const DELAY_MS = 1500; // 1.5s between downloads to avoid rate limits
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000; // 5s wait after rate limit hit

const BG_COLOR = { r: 26, g: 26, b: 46, alpha: 1 }; // #1a1a2e

/* ---------------- HELPER FUNCTIONS ---------------- */
function ensurePostersDir() {
    if (!fs.existsSync(POSTERS_DIR)) {
        fs.mkdirSync(POSTERS_DIR, { recursive: true });
        console.log('Created posters directory');
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getSafeChannelId(channelId) {
    return channelId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function loadCustomChannels() {
    try {
        const customChannelsPath = path.join(__dirname, 'custom-channels.json');
        if (fs.existsSync(customChannelsPath)) {
            const data = fs.readFileSync(customChannelsPath, 'utf8');
            const parsed = JSON.parse(data);

            // Remove config if present
            if (parsed._config) {
                delete parsed._config;
            }

            return Object.values(parsed);
        }
    } catch (error) {
        console.warn('Failed to load custom channels:', error.message);
    }
    return [];
}

async function fetchIptvChannels() {
    console.log('Fetching Romanian channels from iptv-org...');
    const response = await axios.get(IPTV_CHANNELS_URL);
    const romanianChannels = response.data.filter(c => c.country === COUNTRY);
    console.log(`Found ${romanianChannels.length} Romanian channels from iptv-org`);
    return romanianChannels;
}

async function fetchStreams() {
    console.log('Fetching streams data...');
    const response = await axios.get(IPTV_STREAMS_URL);
    console.log(`Loaded ${response.data.length} stream entries`);
    return response.data;
}

async function fetchLogos() {
    console.log('Fetching logos data...');
    const response = await axios.get(IPTV_LOGOS_URL);
    console.log(`Loaded ${response.data.length} logo entries`);
    return response.data;
}

function findLogoUrl(channel, logos) {
    // First check if channel has a direct logo that's not SVG
    if (channel.logo && !channel.logo.endsWith('.svg')) {
        return channel.logo;
    }

    // Then check logos.json for this channel
    const candidates = logos.filter(l =>
        l.channel === channel.id &&
        l.format?.toLowerCase() !== 'svg'
    );

    if (candidates.length > 0) {
        // Sort by width descending and pick the largest
        candidates.sort((a, b) => b.width - a.width);
        return candidates[0].url;
    }

    return null;
}

async function generatePoster(channelId, logoUrl) {
    const safeChannelId = getSafeChannelId(channelId);
    const posterPath = path.join(POSTERS_DIR, `${safeChannelId}.png`);

    // Skip if already exists
    if (fs.existsSync(posterPath)) {
        return { status: 'skipped', reason: 'already exists' };
    }

    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Download logo
            const logoResponse = await axios.get(logoUrl, {
                responseType: 'arraybuffer',
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            const logoBuffer = Buffer.from(logoResponse.data);

            // Generate poster: 480x720 with logo centered
            const finalImage = await sharp(logoBuffer, { density: 300 })
                .resize(320, 400, {
                    fit: 'contain',
                    background: BG_COLOR
                })
                .extend({
                    top: 160,
                    bottom: 160,
                    left: 80,
                    right: 80,
                    background: BG_COLOR
                })
                .png()
                .toBuffer();

            fs.writeFileSync(posterPath, finalImage);
            return { status: 'generated', attempts: attempt };

        } catch (error) {
            lastError = error;

            // If rate limited (429), wait and retry
            if (error.response?.status === 429 && attempt < MAX_RETRIES) {
                const waitTime = RETRY_DELAY_MS * attempt; // Exponential backoff
                process.stdout.write(`rate limited, waiting ${waitTime/1000}s... `);
                await sleep(waitTime);
                continue;
            }

            // For other errors or last attempt, fail
            break;
        }
    }

    return { status: 'failed', reason: lastError.message };
}

/* ---------------- MAIN ---------------- */
async function main() {
    console.log('='.repeat(50));
    console.log('Poster Warmup Script');
    console.log('='.repeat(50));
    console.log('');

    ensurePostersDir();

    // Fetch all data
    const [iptvChannels, streams, logos, customChannels] = await Promise.all([
        fetchIptvChannels(),
        fetchStreams(),
        fetchLogos(),
        loadCustomChannels()
    ]);

    console.log(`Loaded ${customChannels.length} custom channels`);

    // Build set of channel IDs that have available streams
    const channelsWithStreams = new Set(streams.map(s => s.channel));
    console.log(`Channels with streams: ${channelsWithStreams.size}`);
    console.log('');

    // Build list of channels to process
    const channelsToProcess = [];

    // Add custom channels (they have their own sources)
    for (const channel of customChannels) {
        const logoUrl = channel.logo;
        if (logoUrl && !logoUrl.endsWith('.svg')) {
            channelsToProcess.push({
                id: channel.id,
                name: channel.name,
                logoUrl: logoUrl,
                source: 'custom'
            });
        }
    }

    // Add iptv-org channels ONLY if they have streams
    for (const channel of iptvChannels) {
        if (!channelsWithStreams.has(channel.id)) {
            continue; // Skip channels without streams
        }
        const logoUrl = findLogoUrl(channel, logos);
        if (logoUrl) {
            channelsToProcess.push({
                id: channel.id,
                name: channel.name,
                logoUrl: logoUrl,
                source: 'iptv-org'
            });
        }
    }

    console.log(`Total channels to process: ${channelsToProcess.length}`);
    console.log('');

    // Process channels
    const stats = {
        generated: 0,
        skipped: 0,
        failed: 0,
        noLogo: 0
    };

    const failedChannels = [];

    for (let i = 0; i < channelsToProcess.length; i++) {
        const channel = channelsToProcess[i];
        const progress = `[${i + 1}/${channelsToProcess.length}]`;

        process.stdout.write(`${progress} ${channel.name}... `);

        const result = await generatePoster(channel.id, channel.logoUrl);

        if (result.status === 'generated') {
            console.log('generated');
            stats.generated++;
        } else if (result.status === 'skipped') {
            console.log('skipped (exists)');
            stats.skipped++;
        } else {
            console.log(`failed: ${result.reason}`);
            stats.failed++;
            failedChannels.push({ name: channel.name, id: channel.id, reason: result.reason });
        }

        // Always delay between requests (except skipped)
        if (result.status !== 'skipped') {
            await sleep(DELAY_MS);
        }
    }

    // Summary
    console.log('');
    console.log('='.repeat(50));
    console.log('Summary');
    console.log('='.repeat(50));
    console.log(`Generated: ${stats.generated}`);
    console.log(`Skipped (already exist): ${stats.skipped}`);
    console.log(`Failed: ${stats.failed}`);
    console.log('');

    if (failedChannels.length > 0) {
        console.log('Failed channels:');
        for (const ch of failedChannels) {
            console.log(`  - ${ch.name} (${ch.id}): ${ch.reason}`);
        }
        console.log('');
    }

    // List posters in directory
    const posterFiles = fs.readdirSync(POSTERS_DIR).filter(f => f.endsWith('.png'));
    console.log(`Total posters in /posters: ${posterFiles.length}`);
    console.log('');
    console.log('Done!');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
