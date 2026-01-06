const express = require('express');
const axios = require('axios');
const cors = require('cors');

/* ---------------- CONSTANTS ---------------- */
const PORT = process.env.PORT || 3000;
const COUNTRY = 'RO';
const IPTV_CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const IPTV_STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';
const IPTV_LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';
const IPTV_GUIDES_URL = 'https://iptv-org.github.io/api/guides.json';

// Priority channels to show first (case-insensitive matching)
const PRIORITY_CHANNELS = [
    'pro tv',
    'protv news',
    'antena 1',
    'digi 24',
    'kanal d',
    'kiss tv'
];

/* ---------------- APP SETUP ---------------- */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ---------------- CACHE ---------------- */
let cache = { channels: null, streams: null };
let lastFetch = 0;
const TTL = 60 * 60 * 1000; // 1 hour

let logosCache = null;
let logosLastFetch = 0;
const LOGOS_TTL = 24 * 60 * 60 * 1000; // 24 hours

/* ---------------- DATA FETCHING & CACHING ---------------- */
async function getData() {
    if (cache.channels && Date.now() - lastFetch < TTL) {
        return cache;
    }

    console.log('Fetching fresh data from iptv-org API...');

    const [channelsRes, streamsRes] = await Promise.all([
        axios.get(IPTV_CHANNELS_URL),
        axios.get(IPTV_STREAMS_URL)
    ]);

    // Filter channels to only Romanian channels
    const romanianChannels = channelsRes.data.filter(c => c.country === COUNTRY);

    cache = {
        channels: romanianChannels,
        streams: streamsRes.data
    };
    lastFetch = Date.now();

    console.log(`Loaded ${romanianChannels.length} Romanian channels`);
    return cache;
}

async function fetchLogos() {
    if (logosCache && Date.now() - logosLastFetch < LOGOS_TTL) {
        return logosCache;
    }

    console.log('Fetching logos data...');
    const res = await axios.get(IPTV_LOGOS_URL);
    logosCache = res.data;
    logosLastFetch = Date.now();
    return logosCache;
}

/* ---------------- HELPER FUNCTIONS ---------------- */
async function getPoster(channel) {
    // Priority 1: Horizontal logos from logos.json (widest, non-SVG)
    const logos = await fetchLogos();
    const candidates = logos.filter(l =>
        l.channel === channel.id &&
        l.tags?.includes('horizontal') &&
        l.format?.toLowerCase() !== 'svg'
    );

    if (candidates.length) {
        candidates.sort((a, b) => b.width - a.width);
        return candidates[0].url;
    }

    // Priority 2: Channel's logo field (if not SVG)
    if (channel.logo && !channel.logo.endsWith('.svg')) {
        return channel.logo;
    }

    // Priority 3: Default iptv-org logo pattern
    if (channel.id) {
        return `https://iptv-org.github.io/logo/${channel.id}.png`;
    }

    // Fallback: Stremio default background
    return 'https://dl.strem.io/addon-background-landscape.jpg';
}

async function toMeta(channel) {
    const poster = await getPoster(channel);

    // Build description with available channel info
    const descriptionParts = ['Romania'];

    // Add categories/genres
    if (channel.categories && channel.categories.length > 0) {
        descriptionParts.push(channel.categories.join(', '));
    }

    // Add network/broadcaster if available
    if (channel.network) {
        descriptionParts.push(`Network: ${channel.network}`);
    }

    // Add language info
    if (channel.languages && channel.languages.length > 0) {
        descriptionParts.push(`Languages: ${channel.languages.join(', ')}`);
    }

    return {
        id: `rotv-${channel.id}`,
        type: 'tv',
        name: channel.name,
        poster,
        posterShape: 'landscape',
        background: poster,
        logo: poster,
        description: descriptionParts.join(' • ')
    };
}

/* ---------------- MANIFEST ENDPOINT ---------------- */
app.get('/manifest.json', async (req, res) => {
    const { channels } = await getData();

    // Get all unique genres from Romanian channels
    const allGenres = [...new Set(channels.flatMap(c => c.categories || []))].sort();

    res.json({
        id: 'org.romanian-tv',
        name: 'Romanian TV',
        version: '1.0.0',
        description: 'Live Romanian IPTV channels with EPG support',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        idPrefixes: ['rotv-'],
        catalogs: [
            {
                type: 'tv',
                id: 'rotv-all',
                name: 'Romanian TV',
                extra: [
                    { name: 'search', isRequired: false },
                    { name: 'genre', isRequired: false, options: allGenres },
                    { name: 'skip', isRequired: false }
                ]
            }
        ]
    });
});

/* ---------------- CATALOG ENDPOINT ---------------- */
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    const params = Object.fromEntries(new URLSearchParams(req.params.extra || ''));
    const { channels, streams } = await getData();
    const skip = parseInt(params.skip) || 0;

    // Filter channels that have available streams
    let results = channels.filter(c => streams.some(s => s.channel === c.id));

    // Apply genre filter if provided
    if (params.genre) {
        results = results.filter(c => c.categories?.includes(params.genre));
    }

    // Apply search filter if provided
    if (params.search) {
        const q = params.search.toLowerCase();
        results = results.filter(c => c.name.toLowerCase().includes(q));
    }

    // Priority channel logic: show only priority channels on first load (skip=0, no filters)
    if (skip === 0 && !params.search && !params.genre) {
        // Show only priority channels
        results = results.filter(c =>
            PRIORITY_CHANNELS.some(priority =>
                c.name.toLowerCase().includes(priority.toLowerCase())
            )
        );
        // Sort priority channels in the order defined
        results.sort((a, b) => {
            const aIndex = PRIORITY_CHANNELS.findIndex(p => a.name.toLowerCase().includes(p.toLowerCase()));
            const bIndex = PRIORITY_CHANNELS.findIndex(p => b.name.toLowerCase().includes(p.toLowerCase()));
            return aIndex - bIndex;
        });
    } else if (skip > 0 && !params.search && !params.genre) {
        // Show all OTHER channels (non-priority) when user clicks "See All"
        results = results.filter(c =>
            !PRIORITY_CHANNELS.some(priority =>
                c.name.toLowerCase().includes(priority.toLowerCase())
            )
        );
    }

    // Transform channels to metas
    const metas = await Promise.all(results.map(channel => toMeta(channel)));

    res.json({ metas });
});

/* ---------------- META ENDPOINT ---------------- */
app.get('/meta/:type/:id.json', async (req, res) => {
    const channelId = req.params.id.replace('rotv-', '');
    const { channels } = await getData();

    const channel = channels.find(c => c.id === channelId);
    if (!channel) {
        return res.json({ meta: {} });
    }

    const meta = await toMeta(channel);

    res.json({ meta });
});

/* ---------------- STREAM ENDPOINT ---------------- */
app.get('/stream/:type/:id.json', async (req, res) => {
    const channelId = req.params.id.replace('rotv-', '');
    const { streams } = await getData();

    // Get ALL streams for this channel (HD, SD, different sources)
    const channelStreams = streams.filter(s => s.channel === channelId);

    if (channelStreams.length === 0) {
        return res.json({ streams: [] });
    }

    // Use proxied URL to handle CORS issues
    const baseUrl = `${req.protocol}://${req.headers.host}`;

    // Return all available streams with descriptive titles
    const streamObjects = channelStreams.map(stream => {
        const proxiedUrl = `${baseUrl}/hls-proxy/${encodeURIComponent(stream.url)}`;
        const title = stream.title || `${stream.feed || 'Live'} ${stream.quality || ''}`.trim();

        return {
            url: proxiedUrl,
            title: title,
            name: title // Some Stremio clients use 'name' instead of 'title'
        };
    });

    res.json({ streams: streamObjects });
});

/* ---------------- HLS PROXY ENDPOINT ---------------- */
app.get('/hls-proxy/:streamUrl(*)', async (req, res) => {
    try {
        const streamUrl = decodeURIComponent(req.params.streamUrl);
        console.log('Proxying stream:', streamUrl);

        // Fetch the stream content with redirect following
        const response = await axios.get(streamUrl, {
            responseType: 'stream',
            maxRedirects: 5,
            validateStatus: (status) => status < 400,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // Get final URL after redirects
        const finalUrl = response.request.res.responseUrl || streamUrl;

        console.log('Original URL:', streamUrl);
        console.log('Final URL after redirects:', finalUrl);

        // Detect dead streams that redirect to error pages
        const errorDomains = ['google.com', 'www.google.com', 'yahoo.com', 'bing.com'];
        try {
            const finalDomain = new URL(finalUrl).hostname;
            if (errorDomains.some(domain => finalDomain.includes(domain))) {
                console.error('Stream redirected to error page:', finalUrl);
                return res.status(404).json({
                    error: 'Stream not available',
                    message: 'This stream appears to be dead or blocked'
                });
            }
        } catch (urlError) {
            console.error('Invalid final URL:', finalUrl);
            return res.status(500).json({ error: 'Invalid redirect URL' });
        }

        // Copy relevant headers
        const contentType = response.headers['content-type'] || 'application/vnd.apple.mpegurl';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');

        // If it's an M3U8 playlist, rewrite URLs to go through proxy
        if (contentType.includes('mpegurl') || contentType.includes('m3u8') || streamUrl.includes('.m3u8')) {
            let playlistData = '';

            response.data.on('data', (chunk) => {
                playlistData += chunk.toString('utf8');
            });

            response.data.on('end', () => {
                // Validate playlist content
                if (!playlistData.includes('#EXTM3U')) {
                    console.error('Invalid M3U8 content received');
                    return res.status(500).json({
                        error: 'Invalid stream format',
                        message: 'Response is not a valid M3U8 playlist'
                    });
                }

                const baseUrl = `${req.protocol}://${req.headers.host}`;
                const streamBaseUrl = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);

                try {
                    const rewrittenPlaylist = playlistData.replace(
                        /^(?!#|http)(.+)$/gm,
                        (match) => {
                            try {
                                const trimmedMatch = match.trim();
                                if (!trimmedMatch) return match;

                                const absoluteUrl = trimmedMatch.startsWith('/')
                                    ? new URL(trimmedMatch, new URL(finalUrl).origin).href
                                    : streamBaseUrl + trimmedMatch;
                                return `${baseUrl}/hls-proxy/${encodeURIComponent(absoluteUrl)}`;
                            } catch (err) {
                                // If URL parsing fails, return original line
                                console.warn('Failed to parse segment URL:', match);
                                return match;
                            }
                        }
                    );

                    res.send(rewrittenPlaylist);
                } catch (err) {
                    console.error('Playlist rewrite error:', err.message);
                    res.status(500).json({ error: 'Failed to process playlist' });
                }
            });
        } else {
            // For video segments, just pipe the stream
            response.data.pipe(res);
        }

    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).json({ error: 'Failed to proxy stream', details: error.message });
    }
});

/* ---------------- LANDING PAGE ---------------- */
app.get('/', (req, res) => {
    const manifestUrl = `https://${req.headers.host}/manifest.json`;

    res.send(`<!DOCTYPE html>
<html>
<head>
<title>Romanian TV Stremio Addon</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #fff;
    margin: 0;
    padding: 20px;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
}
.container {
    max-width: 600px;
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: blur(10px);
    padding: 40px;
    border-radius: 20px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}
h1 {
    margin: 0 0 10px 0;
    font-size: 2.5em;
    text-align: center;
}
.subtitle {
    text-align: center;
    opacity: 0.9;
    margin-bottom: 30px;
}
.features {
    background: rgba(255, 255, 255, 0.1);
    padding: 20px;
    border-radius: 10px;
    margin: 20px 0;
}
.features h3 {
    margin-top: 0;
}
.features ul {
    margin: 0;
    padding-left: 20px;
}
.features li {
    margin: 8px 0;
}
.manifest-url {
    background: rgba(0, 0, 0, 0.3);
    padding: 15px;
    border-radius: 8px;
    margin: 20px 0;
    word-break: break-all;
    font-family: monospace;
    font-size: 14px;
}
.buttons {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 20px;
}
button {
    flex: 1;
    min-width: 150px;
    padding: 15px 25px;
    font-size: 16px;
    font-weight: bold;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.3s;
}
.btn-primary {
    background: #fff;
    color: #667eea;
}
.btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}
.btn-secondary {
    background: rgba(255, 255, 255, 0.2);
    color: #fff;
}
.btn-secondary:hover {
    background: rgba(255, 255, 255, 0.3);
}
.footer {
    text-align: center;
    margin-top: 30px;
    opacity: 0.8;
    font-size: 14px;
}
</style>
</head>
<body>
<div class="container">
    <h1>📺 Romanian TV</h1>
    <p class="subtitle">Stremio Addon for Romanian IPTV Channels</p>

    <div class="features">
        <h3>Features:</h3>
        <ul>
            <li>Live Romanian TV channels</li>
            <li>Search functionality</li>
            <li>Genre filtering</li>
        </ul>
    </div>

    <h3>Installation:</h3>
    <div class="manifest-url" id="manifest">${manifestUrl}</div>

    <div class="buttons">
        <button class="btn-primary" onclick="installWeb()">Install on Stremio Web</button>
        <button class="btn-primary" onclick="installApp()">Install on Stremio App</button>
        <button class="btn-secondary" onclick="copyManifest()">Copy Manifest URL</button>
    </div>

    <div class="footer">
        Powered by <a href="https://github.com/iptv-org/iptv" style="color: white;">iptv-org</a>
    </div>
</div>

<script>
function copyManifest() {
    const url = document.getElementById('manifest').textContent;
    navigator.clipboard.writeText(url).then(() => {
        alert('Manifest URL copied to clipboard!');
    });
}

function installWeb() {
    const url = document.getElementById('manifest').textContent;
    window.open('https://web.stremio.com/#/addons?addon=' + encodeURIComponent(url), '_blank');
}

function installApp() {
    const url = document.getElementById('manifest').textContent;
    window.location.href = 'stremio://' + url.replace(/^https?:\\/\\//, '');
}
</script>
</body>
</html>`);
});

/* ---------------- SERVER START ---------------- */
app.listen(PORT, () => {
    console.log(`🇷🇴 Romanian TV addon running`);
});
