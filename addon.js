require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

/* ---------------- CONSTANTS ---------------- */
const PORT = process.env.PORT || 3000;
const ENABLE_CUSTOM_CHANNELS = process.env.ENABLE_CUSTOM_CHANNELS !== 'false';
const COUNTRY = 'RO';
const IPTV_CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const IPTV_STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';
const IPTV_LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';

// Priority channels to show first (case-insensitive matching)
const PRIORITY_CHANNELS = [
    'pro tv',
    'antena 1',
    'discovery',
    'national geographic',
    'eurosport 1',
    'digi 24',
    'euronews romania',
    'kiss tv'
];

/* ---------------- CUSTOM CHANNELS ---------------- */
let customChannels = {};
let customChannelsConfig = { excludeIptvChannelIds: [] };

if (ENABLE_CUSTOM_CHANNELS) {
    try {
        const customChannelsPath = path.join(__dirname, 'custom-channels.json');
        if (fs.existsSync(customChannelsPath)) {
            const data = fs.readFileSync(customChannelsPath, 'utf8');
            const parsed = JSON.parse(data);

            if (parsed._config) {
                customChannelsConfig = parsed._config;
                delete parsed._config;
            }

            customChannels = parsed;
            console.log('✓ Custom channels loaded:', Object.keys(customChannels).length);
        }
    } catch (error) {
        console.warn('⚠️  Failed to load custom channels:', error.message);
    }
} else {
    console.log('✓ Custom channels disabled via ENABLE_CUSTOM_CHANNELS');
}

/* ---------------- APP SETUP ---------------- */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

/* ---------------- CACHE ---------------- */
let cache = { channels: null, streams: null };
let lastFetch = 0;
let lastETag = null;
const TTL = 60 * 60 * 1000; // 1 hour

let logosCache = null;
let logosLastFetch = 0;
const LOGOS_TTL = 24 * 60 * 60 * 1000; // 24 hours

let posterCache = new Map();
const POSTER_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

/* ---------------- TOKEN MANAGEMENT ---------------- */
// Token cache: Map<sourceUrl, {token, remote, expires}>
let tokenCache = new Map();
const TOKEN_REFRESH_LEAD_TIME = 30000; // Refresh 30s before expiry

async function fetchToken(sourceUrl) {
    try {
        const response = await axios.get('https://ivanturbinca.com/securetoken.php', {
            params: { source: sourceUrl },
            timeout: 5000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Referer': 'https://ivanturbinca.com/'
            }
        });

        const data = response.data;
        if (!data.token) {
            throw new Error('No token in response');
        }

        const tokenData = {
            token: data.token,
            remote: data.remote || 'no_check_ip',
            expires: data.expires * 1000
        };

        tokenCache.set(sourceUrl, tokenData);

        return tokenData;
    } catch (error) {
        console.error('❌ Token fetch failed:', error.message);
        throw error;
    }
}

async function getValidToken(sourceUrl) {
    const cached = tokenCache.get(sourceUrl);
    const now = Date.now();

    // Check if we have a valid cached token
    if (cached && cached.expires > now + TOKEN_REFRESH_LEAD_TIME) {
        return cached;
    }

    return await fetchToken(sourceUrl);
}

function appendTokenToUrl(url, tokenData) {
    try {
        const urlObj = new URL(url);
        urlObj.searchParams.set('token', tokenData.token);
        urlObj.searchParams.set('remote', tokenData.remote);
        return urlObj.toString();
    } catch (err) {
        const sep = url.includes('?') ? '&' : '?';
        return `${url}${sep}token=${encodeURIComponent(tokenData.token)}&remote=${encodeURIComponent(tokenData.remote)}`;
    }
}

/* ---------------- DATA FETCHING & CACHING ---------------- */
// Helper function to normalize channel names for comparison
function normalizeChannelName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '') // Remove all non-alphanumeric characters
        .replace(/\s+/g, ''); // Remove whitespace
}

// Helper function to check if two channel names match
function channelNamesMatch(name1, name2) {
    const normalized1 = normalizeChannelName(name1);
    const normalized2 = normalizeChannelName(name2);

    if (normalized1 === normalized2) return true;

    // Check if one name contains the other (handles "Pro TV" vs "Pro TV HD")
    if (normalized1.includes(normalized2) || normalized2.includes(normalized1)) {
        return true;
    }

    return false;
}

async function getData() {
    // Check if cache is still valid by time
    if (cache.channels && Date.now() - lastFetch < TTL) {
        // Even if time-valid, check if iptv-org has new data via ETag
        try {
            const headRes = await axios.head(IPTV_STREAMS_URL);
            const currentETag = headRes.headers['etag'];

            // If ETag changed, iptv-org has new data - bust cache immediately
            if (currentETag && currentETag !== lastETag) {
                // Refresh cache
            } else {
                return cache;
            }
        } catch (err) {
            return cache;
        }
    }

    const [channelsRes, streamsRes] = await Promise.all([
        axios.get(IPTV_CHANNELS_URL),
        axios.get(IPTV_STREAMS_URL)
    ]);

    // Store ETag for change detection
    lastETag = streamsRes.headers['etag'];

    // Filter channels to only Romanian channels
    let romanianChannels = channelsRes.data.filter(c => c.country === COUNTRY);

    let allChannels;

    if (ENABLE_CUSTOM_CHANNELS) {
        const customChannelsArray = Object.values(customChannels);

        // DEDUPLICATION & MERGING LOGIC
        customChannelsArray.forEach(customChannel => {
            const matchingIptvChannels = romanianChannels.filter(iptvChannel =>
                channelNamesMatch(customChannel.name, iptvChannel.name)
            );

            if (matchingIptvChannels.length > 0) {
                customChannel.iptvOrgChannelIds = matchingIptvChannels.map(ch => ch.id);
            }
        });

        romanianChannels = romanianChannels.filter(iptvChannel => {
            if (customChannelsConfig.excludeIptvChannelIds?.includes(iptvChannel.id)) {
                return false;
            }
            const matchesCustomChannel = customChannelsArray.some(customChannel =>
                channelNamesMatch(customChannel.name, iptvChannel.name)
            );
            if (matchesCustomChannel) {
                return false;
            }

            return true;
        });

        allChannels = [...customChannelsArray, ...romanianChannels];
    } else {
        // When custom channels are disabled, use only iptv-org channels
        allChannels = romanianChannels;
    }

    cache = {
        channels: allChannels,
        streams: streamsRes.data
    };
    lastFetch = Date.now();

    return cache;
}

async function fetchLogos() {
    if (logosCache && Date.now() - logosLastFetch < LOGOS_TTL) {
        return logosCache;
    }

    const res = await axios.get(IPTV_LOGOS_URL);
    logosCache = res.data;
    logosLastFetch = Date.now();
    return logosCache;
}

/* ---------------- HELPER FUNCTIONS ---------------- */
// Check if a stream URL requires proxying through our server
function streamNeedsProxy(url) {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();

        // Streams that need special headers or token management
        if (hostname.includes('ivanturbinca.com')) return true;
        if (hostname.includes('magicplaces.eu')) return true;
        if (url.includes('hls-proxy.php')) return true;

        // Most iptv-org streams work without proxy (no CORS issues, no special headers needed)
        return false;
    } catch (err) {
        // If URL parsing fails, proxy it to be safe
        return true;
    }
}

async function getPoster(channel) {
    const logos = await fetchLogos();
    const candidates = logos.filter(l =>
        l.channel === channel.id &&
        l.format?.toLowerCase() !== 'svg'
    );

    if (candidates.length) {
        candidates.sort((a, b) => b.width - a.width);
        return candidates[0].url;
    }
    if (channel.logo && !channel.logo.endsWith('.svg')) {
        return channel.logo;
    }
    if (channel.id) {
        return `https://iptv-org.github.io/logo/${channel.id}.png`;
    }

    // Fallback: Stremio default background
    return 'https://dl.strem.io/addon-background-landscape.jpg';
}

async function toMeta(channel, baseUrl = '') {
    const logoUrl = await getPoster(channel);

    const descriptionParts = ['Romania'];

    if (channel.categories && channel.categories.length > 0) {
        descriptionParts.push(channel.categories.join(', '));
    }
    if (channel.network) {
        descriptionParts.push(`Network: ${channel.network}`);
    }
    if (channel.languages && channel.languages.length > 0) {
        descriptionParts.push(`Languages: ${channel.languages.join(', ')}`);
    }
    const landscapePoster = baseUrl
        ? `${baseUrl}/poster-png/${encodeURIComponent(channel.id)}/${encodeURIComponent(logoUrl)}`
        : logoUrl;

    return {
        id: `rotv-${channel.id}`,
        type: 'tv',
        name: channel.name,
        poster: landscapePoster,
        posterShape: 'poster',
        background: landscapePoster,
        description: descriptionParts.join(' • ')
    };
}

/* ---------------- MANIFEST ENDPOINT ---------------- */
app.get('/manifest.json', async (req, res) => {
    const { channels } = await getData();
    const allGenres = [...new Set(channels.flatMap(c => c.categories || []))].sort();
    const baseUrl = `${req.protocol}://${req.headers.host}`;

    res.json({
        id: 'org.romanian-tv',
        name: 'Romanian TV',
        version: '2.0.0',
        description: 'Canale TV românești live',
        logo: `${baseUrl}/logo.png`,
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        idPrefixes: ['rotv-'],
        catalogs: [
            {
                type: 'tv',
                id: 'rotv-all',
                name: 'RO TV',
                extra: [
                    { name: 'search', isRequired: false },
                    { name: 'genre', isRequired: false, options: allGenres },
                    { name: 'skip', isRequired: false }
                ]
            }
        ],
        stremioAddonsConfig: {
            issuer: "https://stremio-addons.net",
            signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..Bv_G0RGi_DFiUZ-2wRvKNQ.Tt-cEjr_Xii3jek_G2Xv3rsiARKPNr62IvzEO29vsHHqdo3JtQ2JrGWAacJeXwELQRk1P6tzcTR--aDsOa-dCCHyC99nm0zuU5C3CfxBsQr3_woOsXu6N9aCTMo3jKbC.cd18-EjFIdJzqmKUImQwyQ"
        }
    });
});

/* ---------------- CATALOG ENDPOINT ---------------- */
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    const params = Object.fromEntries(new URLSearchParams(req.params.extra || ''));
    const { channels, streams } = await getData();
    const skip = parseInt(params.skip) || 0;

    // Filter channels that have available streams (either from iptv-org or custom sources)
    let results = channels.filter(c =>
        c.sources?.length > 0 || streams.some(s => s.channel === c.id)
    );

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
    const baseUrl = `${req.protocol}://${req.headers.host}`;
    const metas = await Promise.all(results.map(channel => toMeta(channel, baseUrl)));

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

    const baseUrl = `${req.protocol}://${req.headers.host}`;
    const meta = await toMeta(channel, baseUrl);

    res.json({ meta });
});

/* ---------------- STREAM ENDPOINT ---------------- */
app.get('/stream/:type/:id.json', async (req, res) => {
    const channelId = req.params.id.replace('rotv-', '');

    const { channels, streams } = await getData();

    // Find the channel (could be custom or iptv-org)
    const channel = channels.find(c => c.id === channelId);

    if (!channel) {
        return res.json({ streams: [] });
    }

    const baseUrl = `${req.protocol}://${req.headers.host}`;
    const allStreams = [];

    // Check if this channel has custom sources
    if (channel.sources?.length > 0) {
        const customStreamObjects = channel.sources.map((source) => {
            let finalUrl;

            if (source.url.includes('ivanturbinca.com/hls-proxy.php')) {
                // Extract the actual source URL from the proxy parameter
                try {
                    const urlObj = new URL(source.url);
                    const srcParam = urlObj.searchParams.get('src');

                    if (srcParam && srcParam.includes('magicplaces.eu')) {
                        // Use token-based playlist proxy
                        finalUrl = `${baseUrl}/token-playlist/${encodeURIComponent(srcParam)}`;
                    } else {
                        // Fallback to external-proxy
                        finalUrl = `${baseUrl}/external-proxy/${encodeURIComponent(source.url)}`;
                    }
                } catch (err) {
                    finalUrl = `${baseUrl}/external-proxy/${encodeURIComponent(source.url)}`;
                }
            } else if (source.url.includes('ivanturbinca.com')) {
                finalUrl = `${baseUrl}/external-proxy/${encodeURIComponent(source.url)}`;
            } else {
                // For other URLs, proxy through our HLS proxy for CORS/URL rewriting
                finalUrl = `${baseUrl}/hls-proxy/${encodeURIComponent(source.url)}`;
            }

            return {
                url: finalUrl,
                title: source.name || 'Live',
                name: source.name || 'Live',
                // Add quality badge if specified
                ...(source.quality && { behaviorHints: { bingeGroup: `quality-${source.quality}` } })
            };
        });

        allStreams.push(...customStreamObjects);
    }

    // Check if this channel has merged iptv-org streams
    if (channel.iptvOrgChannelIds?.length > 0) {
        // Collect streams from all merged iptv-org channels
        channel.iptvOrgChannelIds.forEach(iptvChannelId => {
            const iptvStreams = streams.filter(s => s.channel === iptvChannelId);

            if (iptvStreams.length > 0) {
                const iptvStreamObjects = iptvStreams.map(stream => {
                    // Only proxy if the stream needs special handling
                    const finalUrl = streamNeedsProxy(stream.url)
                        ? `${baseUrl}/hls-proxy/${encodeURIComponent(stream.url)}`
                        : stream.url;

                    const title = stream.title || `${stream.feed || 'IPTV'} ${stream.quality || ''}`.trim();

                    return {
                        url: finalUrl,
                        title: title,
                        name: title
                    };
                });

                allStreams.push(...iptvStreamObjects);
            }
        });
    }

    // If no custom sources, check for direct iptv-org streams (non-custom channels)
    if (!channel.sources && !channel.iptvOrgChannelIds) {
        const channelStreams = streams.filter(s => s.channel === channelId);

        if (channelStreams.length > 0) {
            const iptvStreamObjects = channelStreams.map(stream => {
                // Only proxy if the stream needs special handling
                const finalUrl = streamNeedsProxy(stream.url)
                    ? `${baseUrl}/hls-proxy/${encodeURIComponent(stream.url)}`
                    : stream.url;

                const title = stream.title || `${stream.feed || 'Live'} ${stream.quality || ''}`.trim();

                return {
                    url: finalUrl,
                    title: title,
                    name: title
                };
            });

            allStreams.push(...iptvStreamObjects);
        }
    }

    if (allStreams.length === 0) {
        return res.json({ streams: [] });
    }

    res.json({ streams: allStreams });
});

/* ---------------- TOKEN-BASED PLAYLIST PROXY ---------------- */
app.get('/token-playlist/:sourceUrl(*)', async (req, res) => {
    try {
        const sourceUrl = decodeURIComponent(req.params.sourceUrl);

        // Extract base URL for token generation
        // Tokens must be generated using the base master playlist (e.g., video.m3u8)
        // not sub-playlists (e.g., tracks-v1a1/mono.m3u8)
        // For magicplaces.eu streams, the base is always at /channelname/video.m3u8
        const urlObj = new URL(sourceUrl);
        const pathParts = urlObj.pathname.split('/').filter(p => p);
        // Base URL is protocol://host/firstPathSegment/video.m3u8
        const baseTokenUrl = `${urlObj.protocol}//${urlObj.host}/${pathParts[0]}/video.m3u8`;

        // Get a valid token using the base URL
        const tokenData = await getValidToken(baseTokenUrl);

        // Fetch the playlist through external proxy
        const proxyUrl = `https://ivanturbinca.com/hls-proxy.php?src=${encodeURIComponent(sourceUrl)}`;
        const response = await axios.get(proxyUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Referer': 'https://ivanturbinca.com/'
            }
        });

        const playlistData = response.data;

        // Validate M3U8 format
        if (!playlistData.includes('#EXTM3U')) {
            return res.status(500).json({ error: 'Invalid playlist format' });
        }

        const baseUrl = `${req.protocol}://${req.headers.host}`;
        const sourceBase = `${urlObj.protocol}//${urlObj.hostname}`;

        // Rewrite URLs in the playlist
        const rewrittenPlaylist = playlistData.replace(
            /^(?!#|http)(.+)$/gm,
            (match) => {
                const trimmedMatch = match.trim();
                if (!trimmedMatch) return match;

                // Convert relative/proxy URLs to absolute magicplaces.eu URLs
                let absoluteUrl;
                if (trimmedMatch.startsWith('/hls-proxy.php?src=')) {
                    // Extract the actual URL from the proxy parameter
                    const srcMatch = trimmedMatch.match(/src=([^&]+)/);
                    if (srcMatch) {
                        absoluteUrl = decodeURIComponent(srcMatch[1]);
                    } else {
                        return match;
                    }
                } else if (trimmedMatch.startsWith('/')) {
                    absoluteUrl = `${sourceBase}${trimmedMatch}`;
                } else {
                    absoluteUrl = trimmedMatch;
                }

                // Check if this is another m3u8 file or a video segment
                if (absoluteUrl.includes('.m3u8')) {
                    // Nested m3u8 playlists also go through token-playlist endpoint
                    return `${baseUrl}/token-playlist/${encodeURIComponent(absoluteUrl)}`;
                } else {
                    // Video segments get tokens appended and are served directly by magicplaces.eu
                    return appendTokenToUrl(absoluteUrl, tokenData);
                }
            }
        );

        // Return the rewritten playlist with CORS headers
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
        res.send(rewrittenPlaylist);

    } catch (error) {
        console.error('❌ Token playlist error:', error.message);
        res.status(500).json({
            error: 'Failed to fetch token playlist',
            details: error.message
        });
    }
});

/* ---------------- EXTERNAL PROXY WRAPPER ---------------- */
app.get('/external-proxy/:streamUrl(*)', async (req, res) => {
    try {
        const streamUrl = decodeURIComponent(req.params.streamUrl);
        const response = await axios.get(streamUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://rds.live/',
                'Origin': 'https://rds.live'
            }
        });

        const playlistData = response.data;
        const urlObj = new URL(streamUrl);
        const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
        const ourBaseUrl = `${req.protocol}://${req.headers.host}`;

        const rewrittenPlaylist = playlistData.replace(
            /^(?!#|http)(.+)$/gm,
            (match) => {
                const trimmedMatch = match.trim();
                if (!trimmedMatch) return match;

                const absoluteUrl = trimmedMatch.startsWith('/')
                    ? `${baseUrl}${trimmedMatch}`
                    : match;

                // Wrap all URLs (both m3u8 and segments) through appropriate proxy
                // m3u8 files go through external-proxy for URL rewriting
                // segments go through hls-proxy for CORS and token handling
                if (absoluteUrl.includes('.m3u8')) {
                    return `${ourBaseUrl}/external-proxy/${encodeURIComponent(absoluteUrl)}`;
                } else {
                    // Route segments through hls-proxy to handle CORS
                    return `${ourBaseUrl}/hls-proxy/${encodeURIComponent(absoluteUrl)}`;
                }
            }
        );

        // Return the rewritten playlist
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(rewrittenPlaylist);

    } catch (error) {
        console.error('External proxy wrapper error:', error.message);
        res.status(500).json({ error: 'Failed to fetch external stream' });
    }
});

/* ---------------- HLS PROXY ENDPOINT ---------------- */
app.get('/hls-proxy/:streamUrl(*)', async (req, res) => {
    try {
        const streamUrl = decodeURIComponent(req.params.streamUrl);

        // Prepare headers - include Referer for external proxies
        const requestHeaders = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        };

        // Add Referer and Origin for external proxy requests to prevent 403 errors
        try {
            const urlObj = new URL(streamUrl);
            if (urlObj.hostname === 'ivanturbinca.com') {
                requestHeaders['Referer'] = 'https://rds.live/';
                requestHeaders['Origin'] = 'https://rds.live';
            }
        } catch (e) {
            // Invalid URL, continue without Referer
        }

        // Fetch the stream content with redirect following
        const response = await axios.get(streamUrl, {
            responseType: 'stream',
            maxRedirects: 5,
            timeout: 10000,
            validateStatus: (status) => status < 400,
            headers: requestHeaders,
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });

        // Get final URL after redirects
        const finalUrl = response.request.res.responseUrl || streamUrl;

        // Detect dead streams that redirect to error pages
        const errorDomains = ['google.com', 'www.google.com', 'yahoo.com', 'bing.com'];
        try {
            const finalDomain = new URL(finalUrl).hostname;
            if (errorDomains.some(domain => finalDomain.includes(domain))) {
                return res.status(404).json({
                    error: 'Stream not available',
                    message: 'This stream appears to be dead or blocked'
                });
            }
        } catch (urlError) {
            return res.status(500).json({ error: 'Invalid redirect URL' });
        }

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
                    // Check if it's an HTML error page
                    const isHTML = playlistData.trim().toLowerCase().startsWith('<!doctype') ||
                                   playlistData.trim().toLowerCase().startsWith('<html');

                    return res.status(404).json({
                        error: 'Stream unavailable',
                        message: isHTML ? 'Stream returned an error page (expired or blocked)' : 'Invalid M3U8 format'
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
                                return match;
                            }
                        }
                    );

                    res.send(rewrittenPlaylist);
                } catch (err) {
                    res.status(500).json({ error: 'Failed to process playlist' });
                }
            });
        } else {
            // For video segments, just pipe the stream
            response.data.pipe(res);
        }

    } catch (error) {
        // Provide specific error messages based on error type
        let statusCode = 500;
        let errorMessage = 'Failed to proxy stream';

        if (error.code === 'ECONNREFUSED') {
            statusCode = 503;
            errorMessage = 'Stream server refused connection';
        } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
            statusCode = 504;
            errorMessage = 'Stream server timeout';
        } else if (error.response) {
            statusCode = error.response.status;
            errorMessage = `Stream server returned ${error.response.status}`;
        }

        res.status(statusCode).json({
            error: errorMessage,
            details: error.message
        });
    }
});

/* ---------------- POSTER GENERATOR ENDPOINT (PNG) ---------------- */
app.get('/poster-png/:channelId/:logoUrl(*)', async (req, res) => {
    try {
        const logoUrl = decodeURIComponent(req.params.logoUrl);
        const channelId = decodeURIComponent(req.params.channelId);
        const cacheKey = `${channelId}-${logoUrl}`;
        const cached = posterCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < POSTER_TTL) {
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=604800'); // Cache for 7 days
            res.setHeader('X-Cache', 'HIT');
            return res.send(cached.buffer);
        }
        const logoResponse = await axios.get(logoUrl, {
            responseType: 'arraybuffer',
            timeout: 5000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const logoBuffer = Buffer.from(logoResponse.data);

        // Get logo dimensions and resize to fit in 320x400 box (with padding for TV)
        const logoImage = sharp(logoBuffer);
        const logoMetadata = await logoImage.metadata();

        // Calculate resize dimensions maintaining aspect ratio
        const maxWidth = 320;
        const maxHeight = 400;
        let resizeWidth = logoMetadata.width;
        let resizeHeight = logoMetadata.height;

        if (resizeWidth > maxWidth || resizeHeight > maxHeight) {
            const widthRatio = maxWidth / resizeWidth;
            const heightRatio = maxHeight / resizeHeight;
            const ratio = Math.min(widthRatio, heightRatio);
            resizeWidth = Math.round(resizeWidth * ratio);
            resizeHeight = Math.round(resizeHeight * ratio);
        }

        // Resize logo
        const resizedLogo = await sharp(logoBuffer)
            .resize(resizeWidth, resizeHeight, { fit: 'inside' })
            .toBuffer();

        // Create dark background (480x720 - portrait 2:3 ratio)
        const background = await sharp({
            create: {
                width: 480,
                height: 720,
                channels: 4,
                background: { r: 26, g: 26, b: 46, alpha: 1 } // #1a1a2e
            }
        }).png().toBuffer();

        const left = Math.round((480 - resizeWidth) / 2);
        const top = Math.round((720 - resizeHeight) / 2);
        const finalImage = await sharp(background)
            .composite([{
                input: resizedLogo,
                left,
                top
            }])
            .png()
            .toBuffer();

        posterCache.set(cacheKey, {
            buffer: finalImage,
            timestamp: Date.now()
        });

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=604800'); // Cache for 7 days
        res.setHeader('X-Cache', 'MISS');
        res.send(finalImage);

    } catch (error) {
        console.error('Poster generation error:', error.message, 'for URL:', req.params.logoUrl);
        const logoUrl = decodeURIComponent(req.params.logoUrl);
        res.redirect(logoUrl);
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
* {
    box-sizing: border-box;
}
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    background: #0a0e27;
    background-image:
        radial-gradient(at 0% 0%, rgba(139, 92, 246, 0.15) 0px, transparent 50%),
        radial-gradient(at 100% 0%, rgba(236, 72, 153, 0.12) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(59, 130, 246, 0.15) 0px, transparent 50%),
        radial-gradient(at 0% 100%, rgba(16, 185, 129, 0.12) 0px, transparent 50%);
    color: #e0e7ff;
    margin: 0;
    padding: 20px;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
}
.container {
    max-width: 700px;
    width: 100%;
    background: rgba(15, 23, 42, 0.8);
    border: 1px solid rgba(139, 92, 246, 0.3);
    backdrop-filter: blur(20px);
    padding: 50px;
    border-radius: 16px;
    box-shadow:
        0 20px 60px rgba(0, 0, 0, 0.5),
        0 0 0 1px rgba(139, 92, 246, 0.1),
        0 0 40px rgba(139, 92, 246, 0.1);
}
h1 {
    margin: 0;
    font-size: 2.75em;
    font-weight: 700;
    background: linear-gradient(135deg, #a78bfa 0%, #ec4899 50%, #3b82f6 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    letter-spacing: -0.02em;
}
.subtitle {
    text-align: center;
    color: #c4b5fd;
    margin-bottom: 40px;
    font-size: 1.1em;
    font-weight: 400;
}
.features {
    background: linear-gradient(135deg, rgba(139, 92, 246, 0.1) 0%, rgba(59, 130, 246, 0.1) 100%);
    border: 1px solid rgba(139, 92, 246, 0.3);
    padding: 24px 28px;
    border-radius: 12px;
    margin: 30px 0;
    box-shadow: 0 4px 12px rgba(139, 92, 246, 0.1);
}
.features h3 {
    margin: 0 0 16px 0;
    font-size: 1.1em;
    font-weight: 600;
    color: #cbd5e1;
}
.features ul {
    margin: 0;
    padding-left: 24px;
    list-style: none;
}
.features li {
    margin: 10px 0;
    padding-left: 8px;
    position: relative;
    color: #94a3b8;
}
.features li:before {
    content: "✓";
    position: absolute;
    left: -16px;
    color: #a78bfa;
    font-weight: bold;
    text-shadow: 0 0 8px rgba(167, 139, 250, 0.5);
}
.features li:nth-child(2):before {
    color: #ec4899;
    text-shadow: 0 0 8px rgba(236, 72, 153, 0.5);
}
.screenshots {
    margin: 30px 0;
}
.screenshots h3 {
    margin-bottom: 20px;
}
.screenshot-item {
    margin-bottom: 24px;
}
.screenshot-item:last-child {
    margin-bottom: 0;
}
.screenshot-item img {
    width: 100%;
    border-radius: 8px;
    border: 1px solid rgba(139, 92, 246, 0.3);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    display: block;
}
.screenshot-label {
    text-align: center;
    color: #94a3b8;
    font-size: 0.9em;
    margin-top: 8px;
    margin-bottom: 0;
}
h3 {
    font-size: 1em;
    font-weight: 600;
    color: #cbd5e1;
    margin-bottom: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.875em;
}
.manifest-container {
    margin: 16px 0 30px 0;
}
.manifest-url-wrapper {
    display: flex;
    gap: 8px;
    align-items: stretch;
}
.manifest-url {
    flex: 1;
    background: rgba(15, 23, 42, 0.9);
    border: 1px solid rgba(139, 92, 246, 0.3);
    padding: 16px 18px;
    border-radius: 8px;
    word-break: break-all;
    font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
    font-size: 13px;
    color: #a78bfa;
    line-height: 1.6;
    box-shadow: 0 0 12px rgba(139, 92, 246, 0.1);
}
.btn-copy {
    background: rgba(51, 65, 85, 0.6);
    border: 1px solid rgba(71, 85, 105, 0.4);
    color: #e0e7ff;
    padding: 16px 20px;
    font-size: 14px;
    font-weight: 600;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
    font-family: inherit;
    white-space: nowrap;
    min-width: 80px;
}
.btn-copy:hover {
    background: rgba(51, 65, 85, 0.8);
    border-color: rgba(71, 85, 105, 0.6);
}
.btn-copy:active {
    transform: scale(0.98);
}
.btn-copy.copied {
    background: rgba(34, 197, 94, 0.2);
    border-color: rgba(34, 197, 94, 0.4);
    color: #86efac;
}
.buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-top: 24px;
}
button {
    padding: 16px 24px;
    font-size: 15px;
    font-weight: 600;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
    font-family: inherit;
}
.btn-primary {
    background: linear-gradient(135deg, #a78bfa 0%, #ec4899 50%, #3b82f6 100%);
    color: #ffffff;
    box-shadow: 0 4px 12px rgba(167, 139, 250, 0.4);
}
.btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(167, 139, 250, 0.6), 0 0 30px rgba(236, 72, 153, 0.3);
}
.btn-primary:active {
    transform: translateY(0);
}
.btn-secondary {
    background: rgba(51, 65, 85, 0.6);
    border: 1px solid rgba(71, 85, 105, 0.4);
    color: #e0e7ff;
}
.btn-secondary:hover {
    background: rgba(51, 65, 85, 0.8);
    border-color: rgba(71, 85, 105, 0.6);
}
.support {
    text-align: center;
    margin-top: 30px;
    padding-top: 30px;
    border-top: 1px solid rgba(139, 92, 246, 0.2);
}
.support p {
    margin: 0 0 16px 0;
    color: #94a3b8;
    font-size: 14px;
}
.btn-kofi {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 24px;
    background: linear-gradient(135deg, #a78bfa 0%, #ec4899 50%, #3b82f6 100%);
    color: #ffffff;
    text-decoration: none;
    border-radius: 8px;
    font-weight: 600;
    font-size: 14px;
    transition: all 0.2s ease;
    box-shadow: 0 4px 12px rgba(167, 139, 250, 0.4);
}
.btn-kofi:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(167, 139, 250, 0.6), 0 0 30px rgba(236, 72, 153, 0.3);
}
.btn-kofi img {
    height: 20px;
    width: 20px;
}
.footer {
    text-align: center;
    margin-top: 20px;
    color: #64748b;
    font-size: 14px;
    width: 100%;
    max-width: 700px;
}
.footer a {
    color: #a78bfa;
    text-decoration: none;
    transition: color 0.2s;
}
.footer a:hover {
    color: #c4b5fd;
}
.header {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 20px;
    margin-bottom: 8px;
}
.logo {
    width: 80px;
    height: 80px;
    flex-shrink: 0;
}
@media (max-width: 600px) {
    .container {
        padding: 30px 24px;
    }
    h1 {
        font-size: 2em;
    }
    .buttons {
        grid-template-columns: 1fr;
    }
    .manifest-url-wrapper {
        flex-direction: column;
    }
    .btn-copy {
        width: 100%;
    }
    .header {
        gap: 16px;
    }
    .logo {
        width: 64px;
        height: 64px;
    }
}
</style>
</head>
<body>
<div class="container">
    <div class="header">
        <img src="/logo.png" alt="Romanian TV Logo" class="logo" />
        <h1>Romanian TV</h1>
    </div>
    <p class="subtitle">Addon Stremio pentru Canale TV Românești</p>

    <h3>URL</h3>
    <div class="manifest-container">
        <div class="manifest-url-wrapper">
            <div class="manifest-url" id="manifest">${manifestUrl}</div>
            <button class="btn-copy" id="copyBtn" onclick="copyManifest()">Copiază</button>
        </div>
    </div>

    <div class="buttons">
        <button class="btn-primary" onclick="installWeb()">Instalează pe Stremio Web</button>
        <button class="btn-primary" onclick="installApp()">Instalează pe Aplicația Stremio</button>
    </div>

    <div class="screenshots">
        <div class="screenshot-item">
            <img src="/board.png" alt="Pagina Principală Romanian TV" />
        </div>
    </div>

    <div class="support">
        <p>Îți place acest addon? ♥️ Susține-mă!</p>
        <a href="https://ko-fi.com/dianadragoi#" target="_blank" rel="noopener" class="btn-kofi">
            <img src="https://storage.ko-fi.com/cdn/cup-border.png" alt="Ko-fi" />
            Cumpara-mi o cafea
        </a>
    </div>
</div>

<div class="footer">
    Dezvoltat de <a href="https://github.com/dianadragoi35" target="_blank" rel="noopener">dianadragoi</a> •
    Oferit de <a href="https://github.com/iptv-org/iptv" target="_blank" rel="noopener">iptv-org</a>
</div>

<script>
function copyManifest() {
    const url = document.getElementById('manifest').textContent;
    const btn = document.getElementById('copyBtn');
    navigator.clipboard.writeText(url).then(() => {
        btn.textContent = 'Copiat!';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.textContent = 'Copiază';
            btn.classList.remove('copied');
        }, 2000);
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
