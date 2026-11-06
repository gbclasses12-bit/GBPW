import express from 'express';
import https from 'node:https';
import type http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import fs from 'node:fs';

const app = express();
const TARGET_HOST = 'www.learnxpw.site';
const TARGET_ORIGIN = `https://${TARGET_HOST}`;

// Brand settings configured as requested
const BRAND_NAME = 'GB STUDY';
const TELEGRAM_URL = 'https://t.me/GBFreestudy';
const ICON_URL = 'https://i.ibb.co/Q3g9fGSt/1791541921524.png';
const OLD_ICON_URL = 'https://i.ibb.co/V8CbjrG/image.png';
const OLD_TG_URL = 'https://t.me/+AgMz8cG-x8VmNGY1';
const OLD_TG_URL_ALT = 'https://t.me/AgMz8cG-x8VmNGY1';

// High-performance HTTP Keep-Alive Agent for reusable warm TCP/TLS sockets
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: 30000,
});

// In-memory cache for static JS/CSS assets (immutable) to achieve 0ms response time
const staticAssetCache = new Map<string, { body: Buffer; headers: Record<string, any> }>();

// High-speed Page & RSC Cache to make NextToppers, MissionJeet, and Batches open instantly (0ms)
const pageCache = new Map<
  string,
  { body: Buffer; headers: Record<string, any>; timestamp: number }
>();

// Full-access session cache to completely eliminate key generation and shorteners
let cachedAccessCookie =
  'studymeta_access=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzY29wZSI6ImZ1bGwiLCJpYXQiOjE3OTM2MjM4ODAsImV4cCI6MTc5MzcxMDI4MH0.RRjEAcW3pPiuWyKF6EDDgK0epLc-gCLCVMna1DFk_nA';
let refreshPromise: Promise<string> | null = null;

// High-speed TTL Caches to make study endpoints instantaneous (0ms)
interface CacheEntry<T> {
  data: T;
  rawString?: string;
  timestamp: number;
}
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const batchInfoCache = new Map<string, CacheEntry<any>>();
const subjectInfoCache = new Map<string, CacheEntry<any>>();
const topicInfoCache = new Map<string, CacheEntry<any>>();
const allBatchesCache = new Map<string, CacheEntry<any>>();

function isTokenExpired(cookieStr: string): boolean {
  try {
    const rawJwt = cookieStr.replace(/^studymeta_access=/, '').split(';')[0];
    const parts = rawJwt.split('.');
    if (parts.length < 2) return true;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    if (!payload.exp) return true;
    // Auto-refresh when within 2 hours of expiry (7200s) so it never expires during user browsing
    return Math.floor(Date.now() / 1000) >= payload.exp - 7200;
  } catch {
    return true;
  }
}

// Proactively keep session token alive 24/7 by refreshing every 6 hours
setInterval(async () => {
  try {
    console.log('[Heartbeat] Proactively refreshing session token...');
    await fetchFreshAccessCookie();
  } catch (err) {
    console.warn('[Heartbeat] Proactive token refresh error:', err);
  }
}, 6 * 60 * 60 * 1000);

async function fetchFreshAccessCookie(): Promise<string> {
  try {
    const anonId = 'anon_' + Date.now();
    const pageData = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const getReq = https.get(
        `${TARGET_ORIGIN}/key-generate?redirect=%2Fstudy%2Fbatches&type=full&anon_id=${anonId}`,
        {
          headers: {
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            referer: `${TARGET_ORIGIN}/study/batches`,
            cookie: `anon_id=${anonId}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode || 200,
              body: Buffer.concat(chunks).toString('utf-8'),
            })
          );
        }
      );
      getReq.setTimeout(8000, () => {
        getReq.destroy();
        reject(new Error('Timeout fetching key-generate page'));
      });
      getReq.on('error', reject);
    });

    const m = pageData.body.match(/\\?"token\\?":\s*\\?"([^"\\]+)\\?"/);
    if (!m || !m[1]) {
      return cachedAccessCookie;
    }

    const token = m[1];
    const verifyData = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const verifyReq = https.request(
        `${TARGET_ORIGIN}/api/complete-verification`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            referer: `${TARGET_ORIGIN}/verify?token=${encodeURIComponent(token)}`,
          },
        },
        (res) => {
          resolve({ status: res.statusCode || 200, headers: res.headers });
        }
      );
      verifyReq.setTimeout(8000, () => {
        verifyReq.destroy();
        reject(new Error('Timeout completing verification'));
      });
      verifyReq.on('error', reject);
      verifyReq.write(JSON.stringify({ token }));
      verifyReq.end();
    });

    const setCookies = verifyData.headers['set-cookie'] || [];
    const accessCookie = (
      Array.isArray(setCookies) ? setCookies : [setCookies]
    ).find((c) => c.startsWith('studymeta_access='));

    if (accessCookie) {
      cachedAccessCookie = accessCookie.split(';')[0];
      return cachedAccessCookie;
    }
  } catch (err) {
    console.error('Failed to auto-refresh access cookie:', err);
  }
  return cachedAccessCookie;
}

async function getAccessCookie(): Promise<string> {
  if (cachedAccessCookie && !isTokenExpired(cachedAccessCookie)) {
    return cachedAccessCookie;
  }
  if (!refreshPromise) {
    refreshPromise = fetchFreshAccessCookie().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

/**
 * Executes an HTTP GET request to upstream with the valid access cookie.
 * Automatically refreshes the session token and retries if upstream reports unauthorized or redirects.
 */
async function fetchWithAuth(
  url: string,
  referer: string
): Promise<{ status: number; body: string }> {
  let cookie = await getAccessCookie();

  const doRequest = (c: string) =>
    new Promise<{ status: number; body: string }>((resolve) => {
      const req = https.get(
        url,
        {
          headers: {
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            referer,
            cookie: c,
          },
          agent: keepAliveAgent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () =>
            resolve({
              status: res.statusCode || 200,
              body: Buffer.concat(chunks).toString('utf-8'),
            })
          );
        }
      );
      req.setTimeout(8000, () => {
        req.destroy();
        resolve({ status: 504, body: '' });
      });
      req.on('error', () => resolve({ status: 500, body: '' }));
    });

  let res = await doRequest(cookie);

  if (
    res.status === 401 ||
    res.status === 403 ||
    res.status === 307 ||
    (res.body && res.body.includes('Unauthorised'))
  ) {
    console.log(`Auth invalidated on ${url}, refreshing token and retrying...`);
    cachedAccessCookie = '';
    cookie = await fetchFreshAccessCookie();
    res = await doRequest(cookie);
  }

  return res;
}

// Background pre-warmer to keep essential pages hot in memory for instant 0ms transitions
async function prewarmEssentialPages() {
  const pages = [
    '/study/batches',
    '/study/nexttoppers',
    '/study/missionjeet',
    '/study/vibrant',
    '/study/batches?_rsc=1',
    '/study/nexttoppers?_rsc=1',
    '/study/missionjeet?_rsc=1',
  ];
  for (const p of pages) {
    try {
      const res = await fetchWithAuth(`${TARGET_ORIGIN}${p}`, `${TARGET_ORIGIN}/study/batches`);
      if (res.status === 200 && res.body) {
        const modified = transformText(res.body);
        const isRsc = p.includes('_rsc=');
        pageCache.set(`${p}:${isRsc ? '1' : '0'}`, {
          body: Buffer.from(modified, 'utf-8'),
          headers: {
            'content-type': isRsc ? 'text/x-component' : 'text/html; charset=utf-8',
          },
          timestamp: Date.now(),
        });
      }
    } catch {
      // Ignore background prewarm errors
    }
  }
}

// Pre-warm on server boot (delayed 1s) and every 10 minutes
setTimeout(prewarmEssentialPages, 1000);
setInterval(prewarmEssentialPages, 10 * 60 * 1000);

/**
 * Transforms text responses (HTML, Next.js RSC, JS bundles, API JSON)
 * replacing Name -> GB STUDY, Telegram -> https://t.me/GBFreestudy, Icon -> https://i.ibb.co/Q3g9fGSt/1791541921524.png
 * and completely removing shortener/key-generation prompts.
 */
function transformText(content: string): string {
  let text = content;

  // 1. Strip absolute hostnames so all links stay within this proxy
  text = text.replaceAll('https://www.learnxpw.site', '');
  text = text.replaceAll('http://www.learnxpw.site', '');
  text = text.replaceAll('https:\\/\\/www.learnxpw.site', '');
  text = text.replaceAll('https://learnxpw.site', '');
  text = text.replaceAll('http://learnxpw.site', '');
  text = text.replaceAll('https:\\/\\/learnxpw.site', '');

  // 2. Icon replacement (both direct URL and JSON-escaped slashes, plus path suffix)
  text = text.replaceAll(OLD_ICON_URL, ICON_URL);
  text = text.replaceAll('https:\\/\\/i.ibb.co\\/V8CbjrG\\/image.png', ICON_URL.replace(/\//g, '\\/'));
  text = text.replaceAll('V8CbjrG/image.png', 'Q3g9fGSt/1791541921524.png');
  text = text.replaceAll('V8CbjrG\\/image.png', 'Q3g9fGSt\\/1791541921524.png');
  text = text.replaceAll('https://ibb.co/0R7qc34v', ICON_URL);
  text = text.replaceAll('https:\\/\\/ibb.co\\/0R7qc34v', ICON_URL.replace(/\//g, '\\/'));

  // 3. Telegram URL replacement (both full URL, path, and split tokens)
  text = text.replaceAll(OLD_TG_URL, TELEGRAM_URL);
  text = text.replaceAll('https:\\/\\/t.me\\/+AgMz8cG-x8VmNGY1', TELEGRAM_URL.replace(/\//g, '\\/'));
  text = text.replaceAll(OLD_TG_URL_ALT, TELEGRAM_URL);
  text = text.replaceAll('https:\\/\\/t.me\\/AgMz8cG-x8VmNGY1', TELEGRAM_URL.replace(/\//g, '\\/'));
  text = text.replaceAll('://t.me/+AgMz8cG-x8VmNGY1', '://t.me/GBFreestudy');
  text = text.replaceAll(':\\/\\/t.me\\/+AgMz8cG-x8VmNGY1', ':\\/\\/t.me\\/GBFreestudy');
  text = text.replaceAll('+AgMz8cG-x8VmNGY1', 'GBFreestudy');
  text = text.replaceAll('AgMz8cG-x8VmNGY1', 'GBFreestudy');
  text = text.replaceAll('@bookverse_probot', '@GBFreestudy');

  // 4. Name replacement
  text = text.replaceAll('"webName":"Learnxpw"', `"webName":"${BRAND_NAME}"`);
  text = text.replaceAll('"sidebarTitle":"Learnxpw"', `"sidebarTitle":"${BRAND_NAME}"`);
  text = text.replaceAll('Learnxpw — a comprehensive online study platform', `${BRAND_NAME} — a comprehensive online study platform`);
  text = text.replaceAll('<title>Learnxpw</title>', `<title>${BRAND_NAME}</title>`);
  text = text.replaceAll('© 2026 Learnxpw', `© 2026 ${BRAND_NAME}`);
  text = text.replaceAll('© 2025 Learnxpw', `© 2025 ${BRAND_NAME}`);
  text = text.replaceAll('Learnxpw', BRAND_NAME);
  text = text.replaceAll('LEARNXPW', BRAND_NAME);
  text = text.replaceAll('learnxpw', BRAND_NAME);

  // 5. Disable shorteners and key-generation gates completely in UI config
  text = text.replaceAll(/"shortner_servers":\[[^\]]*\]/g, '"shortner_servers":[]');
  text = text.replaceAll('"isDirectLoginOpen":false', '"isDirectLoginOpen":true');

  // 6. Inject UI Enhancer (PW BOOKS, Powered by GB STUDY, and PW Banner fallback)
  // Injected inside existing head script tag so it executes immediately without React #418 errors
  const EXISTING_HEAD_SCRIPT = "document.querySelectorAll('body link[rel=\"icon\"], body link[rel=\"apple-touch-icon\"]').forEach(el => document.head.appendChild(el))";

  const ENHANCED_HEAD_SCRIPT = `${EXISTING_HEAD_SCRIPT};
(function() {
  if (typeof window === 'undefined') return;
  var pwIconUrl = 'https://i.ibb.co/Q3g9fGSt/1791541921524.png';

  function injectPwBooks() {
    try {
      if (document.querySelector('a[data-pw-books="1"]')) return;
      var targets = document.querySelectorAll('a[href*="missionjeet"], a[href*="nexttoppers"], nav a');
      var target = null;
      for (var i = 0; i < targets.length; i++) {
        var h = targets[i].getAttribute('href') || '';
        if (h.includes('missionjeet')) { target = targets[i]; break; }
      }
      if (!target && targets.length > 0) target = targets[targets.length - 1];
      if (target && target.parentNode && !target.parentNode.querySelector('a[data-pw-books="1"]')) {
        var a = document.createElement('a');
        a.href = 'https://gb-study-1-322206542053.asia-south1.run.app/';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.setAttribute('data-pw-books', '1');
        a.className = target.className || '';
        a.innerHTML = '<div class="flex items-center text-foreground gap-3 px-4 py-3 rounded-lg cursor-pointer text-sm transition-colors duration-200 hover:bg-foreground/20 text-background"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-book-open w-5 h-5 flex-shrink-0 text-[#5a4bda]"><path d="M12 7v14"></path><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"></path></svg><span style="font-weight:600;">PW BOOKS</span></div>';
        target.parentNode.insertBefore(a, target.nextSibling);
      }
    } catch(e) {}
  }

  function injectPoweredBy() {
    try {
      if (document.querySelector('#gb-powered-by')) return;
      var allButtons = document.querySelectorAll('button');
      var parentBox = null;
      for (var i = 0; i < allButtons.length; i++) {
        var txt = (allButtons[i].textContent || '').trim();
        if (txt === 'Load More' || txt === 'Loading...') {
          var pb = allButtons[i].closest('.flex.justify-center') || allButtons[i].parentElement;
          if (pb && pb.parentElement) {
            parentBox = pb.parentElement;
            break;
          }
        }
      }
      if (!parentBox) {
        var grids = document.querySelectorAll('.grid');
        if (grids.length > 0) parentBox = grids[grids.length - 1].parentElement;
      }
      if (!parentBox) {
        var mainEl = document.querySelector('main') || document.body;
        parentBox = mainEl;
      }
      if (parentBox && !parentBox.querySelector('#gb-powered-by')) {
        var pBox = document.createElement('div');
        pBox.id = 'gb-powered-by';
        pBox.className = 'w-full text-center py-6 mt-4 mb-8 flex justify-center items-center text-sm text-slate-400 font-medium tracking-wide';
        pBox.innerHTML = 'Powered by&nbsp;<a href="https://t.me/sarvottamji" target="_blank" rel="noopener noreferrer" class="font-bold underline underline-offset-4 transition-colors" style="color: #ef4444 !important; font-weight: 700; text-decoration: underline; text-underline-offset: 4px;"><span style="color: #ef4444 !important;">GB STUDY</span></a>';
        parentBox.appendChild(pBox);
      }
    } catch(e) {}
  }

  function fixMissingBatchBanners() {
    try {
      var imgs = document.querySelectorAll('img');
      imgs.forEach(function(img) {
        var s = img.getAttribute('src') || img.src || '';
        if (!s || s.trim() === '' || s.includes('undefined') || s.includes('null')) {
          img.src = pwIconUrl;
        }
        if (!img.dataset.pwErrorBound) {
          img.dataset.pwErrorBound = '1';
          img.addEventListener('error', function() {
            this.src = pwIconUrl;
          });
        }
      });
    } catch(e) {}
  }

  var isHydrated = false;

  function enableEnhancer() {
    if (isHydrated) return;
    isHydrated = true;
    runAll();
    setInterval(runAll, 500);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('load', function() {
      setTimeout(enableEnhancer, 1200);
    });

    ['pointerdown', 'touchstart', 'click', 'scroll'].forEach(function(evt) {
      window.addEventListener(evt, function() {
        enableEnhancer();
        setTimeout(runAll, 50);
      }, { passive: true });
    });
  }

  function runAll() {
    if (!isHydrated) return;
    injectPwBooks();
    injectPoweredBy();
    fixMissingBatchBanners();
  }
})();`;

  if (text.includes(EXISTING_HEAD_SCRIPT)) {
    text = text.replace(EXISTING_HEAD_SCRIPT, ENHANCED_HEAD_SCRIPT);
  }

  return text;
}

// Serve locally cached logo if requested
app.get('/logo.png', (_req, res) => {
  const localLogo = path.resolve(process.cwd(), 'public', 'logo.png');
  if (fs.existsSync(localLogo)) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(localLogo).pipe(res);
  } else {
    res.redirect(ICON_URL);
  }
});

// Root path handler: directly redirect to /study/batches so the user lands straight on the batches page
app.get('/', (req, res) => {
  if (req.query.home === '1') {
    handleProxy(req, res, '/');
  } else {
    res.redirect(307, '/study/batches');
  }
});

// Banish key generation routes: immediately redirect to intended destination or /study/batches
app.get('/key-generate', async (req, res) => {
  const cookie = await getAccessCookie();
  if (cookie) {
    res.setHeader('Set-Cookie', `${cookie}; Path=/; SameSite=Lax; Max-Age=86400`);
  }
  const target = (req.query.redirect as string) || '/study/batches';
  res.redirect(307, target);
});

app.get('/verify', async (_req, res) => {
  const cookie = await getAccessCookie();
  if (cookie) {
    res.setHeader('Set-Cookie', `${cookie}; Path=/; SameSite=Lax; Max-Age=86400`);
  }
  res.redirect(307, '/study/batches');
});

app.get('/study/key', (_req, res) => {
  res.redirect(307, '/study/batches');
});

// Resilient /api/Schedule handler: prevents 'Invalid Schedule API response' crashes
app.get('/api/Schedule', async (req, res) => {
  const batchId = (req.query.BatchId || req.query.batchId || req.query.batch_id || '') as string;
  const subjectId = (req.query.SubjectId || req.query.subjectId || req.query.subject_id || '') as string;
  const contentId = (req.query.ContentId || req.query.contentId || req.query.ChildId || req.query.childId || req.query.videoId || req.query.video_id || '') as string;

  const accessCookie = await getAccessCookie();
  const watchReferer = `${TARGET_ORIGIN}/watch?batchId=${batchId}&SubjectId=${subjectId}&ContentId=${contentId}`;

  // 1. Attempt to fetch schedule from upstream with watch referer
  try {
    const upstreamUrl = `${TARGET_ORIGIN}/api/Schedule?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(subjectId)}&ContentId=${encodeURIComponent(contentId)}`;
    const upstreamRes = await new Promise<{ status: number; data: any }>((resolve) => {
      https
        .get(
          upstreamUrl,
          {
            headers: {
              'user-agent':
                (req.headers['user-agent'] as string) ||
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              referer: watchReferer,
              cookie: accessCookie,
            },
          },
          (proxyRes) => {
            const chunks: Buffer[] = [];
            proxyRes.on('data', (c) => chunks.push(c));
            proxyRes.on('end', () => {
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                resolve({ status: proxyRes.statusCode || 200, data: parsed });
              } catch {
                resolve({ status: proxyRes.statusCode || 500, data: null });
              }
            });
          }
        )
        .on('error', () => resolve({ status: 500, data: null }));
    });

    if (
      upstreamRes.status === 200 &&
      upstreamRes.data?.success &&
      (upstreamRes.data?.data?.urlType ||
        (Array.isArray(upstreamRes.data?.data) && upstreamRes.data?.data[0]?.urlType))
    ) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json(upstreamRes.data);
    }
  } catch (err) {
    console.warn('Upstream /api/Schedule fetch encountered error, using resilient fallback:', err);
  }

  // 2. Resilient fallback: Query video-url or synthesize valid schedule structure so watch player never crashes
  let urlType = 'penpencilvdo';
  let videoUrl = '';
  const topic = 'Class Lecture';

  try {
    const vUrl = `${TARGET_ORIGIN}/api/video-url?batch_id=${encodeURIComponent(batchId)}&subject_id=${encodeURIComponent(subjectId)}&video_id=${encodeURIComponent(contentId)}`;
    const vRes = await new Promise<{ status: number; data: any }>((resolve) => {
      https
        .get(
          vUrl,
          {
            headers: {
              'user-agent':
                (req.headers['user-agent'] as string) ||
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              referer: watchReferer,
              cookie: accessCookie,
            },
          },
          (proxyRes) => {
            const chunks: Buffer[] = [];
            proxyRes.on('data', (c) => chunks.push(c));
            proxyRes.on('end', () => {
              try {
                resolve({
                  status: proxyRes.statusCode || 200,
                  data: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
                });
              } catch {
                resolve({ status: proxyRes.statusCode || 500, data: null });
              }
            });
          }
        )
        .on('error', () => resolve({ status: 500, data: null }));
    });

    if (vRes.status === 200 && vRes.data?.success && vRes.data?.data) {
      urlType = vRes.data.data.urlType || 'penpencilvdo';
      videoUrl = vRes.data.data.url || '';
    }
  } catch {
    // Continue with default penpencilvdo
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    success: true,
    data: {
      _id: contentId,
      topic: topic,
      title: topic,
      name: topic,
      urlType: urlType,
      url: videoUrl,
      videoDetails: {},
      availableFor: [],
      platformRestricted: false,
      restrictedSchedule: false,
      restrictedTime: 0,
    },
  });
});

// Always return clean GB STUDY server info with zero shorteners
app.get('/api/auth/serverInfo', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    webName: BRAND_NAME,
    sidebarLogoUrl: ICON_URL,
    sidebarTitle: BRAND_NAME,
    maintenanceMode: false,
    tg_channel: TELEGRAM_URL,
    tg_username: '',
    isDirectLoginOpen: true,
    tg_bot: '@GBFreestudy',
    shortner_servers: [],
  });
});

// High-speed cached AllBatches handler
app.get('/api/AllBatches', async (req, res) => {
  const page = (req.query.page || '1') as string;

  const cached = allBatchesCache.get(page);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS && cached.rawString) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).send(cached.rawString);
  }

  const accessCookie = await getAccessCookie();

  try {
    const upstreamUrl = `${TARGET_ORIGIN}/api/AllBatches?page=${encodeURIComponent(page)}`;
    const upstreamRes = await new Promise<{ status: number; body: string }>((resolve) => {
      const gReq = https.get(
        upstreamUrl,
        {
          headers: {
            'user-agent':
              (req.headers['user-agent'] as string) ||
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            referer: `${TARGET_ORIGIN}/study/batches`,
            cookie: accessCookie,
          },
          agent: keepAliveAgent,
        },
        (proxyRes) => {
          const chunks: Buffer[] = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () =>
            resolve({
              status: proxyRes.statusCode || 200,
              body: Buffer.concat(chunks).toString('utf-8'),
            })
          );
        }
      );
      gReq.setTimeout(8000, () => {
        gReq.destroy();
        resolve({ status: 504, body: '' });
      });
      gReq.on('error', () => resolve({ status: 500, body: '' }));
    });

    if (upstreamRes.status === 200 && upstreamRes.body) {
      try {
        const parsed = JSON.parse(upstreamRes.body);
        if (parsed.success && parsed.batches) {
          // If a batch has no banner/image, attach the PW icon
          for (const b of parsed.batches) {
            if (!b.previewImage || !b.previewImage.startsWith('http') || b.previewImage.trim() === '') {
              b.previewImage = ICON_URL;
            }
          }
          const modified = transformText(JSON.stringify(parsed));
          allBatchesCache.set(page, {
            data: parsed,
            rawString: modified,
            timestamp: Date.now(),
          });
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('X-Cache', 'MISS');
          return res.status(200).send(modified);
        }
      } catch {
        // Fall through
      }
    }
  } catch (err) {
    console.warn('Upstream AllBatches fetch error:', err);
  }

  if (cached && cached.rawString) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(cached.rawString);
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    success: true,
    batches: [],
    totalPages: 1,
    currentPage: 1,
    total: 0,
  });
});

// Resilient /api/BatchInfo handler: prevents 'Failed to search batches' error
app.get('/api/BatchInfo', async (req, res) => {
  const batchId = (req.query.BatchId || req.query.batchId || '') as string;
  const type = ((req.query.Type || req.query.type || 'details') as string).toLowerCase();
  const page = (req.query.page || '1') as string;

  if (!batchId || batchId === 'undefined' || batchId === 'null') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ success: true, data: type === 'details' ? {} : [] });
  }

  const cacheKey = `${batchId}:${type}:${page}`;

  const cached = batchInfoCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS && cached.rawString) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).send(cached.rawString);
  }

  try {
    const upstreamUrl = `${TARGET_ORIGIN}/api/BatchInfo?BatchId=${encodeURIComponent(batchId)}&Type=${encodeURIComponent(type)}${page ? `&page=${encodeURIComponent(page)}` : ''}`;
    const upstreamRes = await fetchWithAuth(upstreamUrl, `${TARGET_ORIGIN}/study/batches/${batchId}`);

    if (upstreamRes.status === 200 && upstreamRes.body) {
      try {
        const parsed = JSON.parse(upstreamRes.body);
        if (parsed.success && parsed.data) {
          const modified = transformText(upstreamRes.body);
          batchInfoCache.set(cacheKey, {
            data: parsed,
            rawString: modified,
            timestamp: Date.now(),
          });
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('X-Cache', 'MISS');
          return res.status(200).send(modified);
        }
      } catch {
        // Fall through
      }
    }
  } catch (err) {
    console.warn('Upstream BatchInfo fetch error:', err);
  }

  if (cached && cached.rawString) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(cached.rawString);
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    success: true,
    data: type === 'details' ? { _id: batchId, name: 'Batch', subjects: [] } : [],
  });
});

// Resilient /api/SubjectInfo handler
app.get('/api/SubjectInfo', async (req, res) => {
  const batchId = (req.query.BatchId || req.query.batchId || '') as string;
  const subjectId = (req.query.SubjectId || req.query.subjectId || '') as string;
  const page = (req.query.page || '1') as string;

  if (!batchId || batchId === 'undefined' || !subjectId || subjectId === 'undefined') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ success: true, data: [] });
  }

  const cacheKey = `${batchId}:${subjectId}:${page}`;

  const cached = subjectInfoCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS && cached.rawString) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).send(cached.rawString);
  }

  try {
    const upstreamUrl = `${TARGET_ORIGIN}/api/SubjectInfo?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(subjectId)}&page=${encodeURIComponent(page)}`;
    const upstreamRes = await fetchWithAuth(upstreamUrl, `${TARGET_ORIGIN}/study/batches/${batchId}`);

    if (upstreamRes.status === 200 && upstreamRes.body) {
      try {
        const parsed = JSON.parse(upstreamRes.body);
        if (parsed && Array.isArray(parsed.data) && parsed.data.length > 0) {
          const modified = transformText(upstreamRes.body);
          subjectInfoCache.set(cacheKey, {
            data: parsed,
            rawString: modified,
            timestamp: Date.now(),
          });
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('X-Cache', 'MISS');
          return res.status(200).send(modified);
        }
      } catch {
        // Fall through
      }
    }
  } catch (err) {
    console.warn('Upstream SubjectInfo fetch error:', err);
  }

  if (cached && cached.rawString) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(cached.rawString);
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({ success: true, data: [] });
});

// Resilient /api/TopicInfo handler
app.get('/api/TopicInfo', async (req, res) => {
  const batchId = (req.query.BatchId || req.query.batchId || '') as string;
  const subjectId = (req.query.SubjectId || req.query.subjectId || '') as string;
  const topicId = (req.query.TopicId || req.query.topicId || '') as string;
  const contentType = (req.query.ContentType || req.query.contentType || 'videos') as string;
  const page = (req.query.page || '1') as string;

  if (
    !batchId ||
    batchId === 'undefined' ||
    !subjectId ||
    subjectId === 'undefined' ||
    !topicId ||
    topicId === 'undefined'
  ) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ success: true, data: [] });
  }

  const cacheKey = `${batchId}:${subjectId}:${topicId}:${contentType}:${page}`;

  const cached = topicInfoCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS && cached.rawString) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).send(cached.rawString);
  }

  try {
    const upstreamUrl = `${TARGET_ORIGIN}/api/TopicInfo?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(subjectId)}&TopicId=${encodeURIComponent(topicId)}&ContentType=${encodeURIComponent(contentType)}&page=${encodeURIComponent(page)}`;
    const upstreamRes = await fetchWithAuth(upstreamUrl, `${TARGET_ORIGIN}/study/batches/${batchId}`);

    if (upstreamRes.status === 200 && upstreamRes.body) {
      try {
        const parsed = JSON.parse(upstreamRes.body);
        if (parsed && Array.isArray(parsed.data) && parsed.data.length > 0) {
          const modified = transformText(upstreamRes.body);
          topicInfoCache.set(cacheKey, {
            data: parsed,
            rawString: modified,
            timestamp: Date.now(),
          });
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('X-Cache', 'MISS');
          return res.status(200).send(modified);
        }
      } catch {
        // Fall through
      }
    }
  } catch (err) {
    console.warn('Upstream TopicInfo fetch error:', err);
  }

  if (cached && cached.rawString) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(cached.rawString);
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({ success: true, data: [] });
});

// Resilient /api/searchBatch handler
app.get('/api/searchBatch', async (req, res) => {
  const name = ((req.query.name as string) || '').trim();
  const page = (req.query.page || '1') as string;
  const accessCookie = await getAccessCookie();

  try {
    const upstreamUrl = `${TARGET_ORIGIN}/api/searchBatch?name=${encodeURIComponent(name)}&page=${encodeURIComponent(page)}`;
    const upstreamRes = await new Promise<{ status: number; body: string }>((resolve) => {
      https
        .get(
          upstreamUrl,
          {
            headers: {
              'user-agent':
                (req.headers['user-agent'] as string) ||
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              referer: `${TARGET_ORIGIN}/study/batches`,
              cookie: accessCookie,
            },
          },
          (proxyRes) => {
            const chunks: Buffer[] = [];
            proxyRes.on('data', (c) => chunks.push(c));
            proxyRes.on('end', () => {
              resolve({
                status: proxyRes.statusCode || 200,
                body: Buffer.concat(chunks).toString('utf-8'),
              });
            });
          }
        )
        .on('error', () => resolve({ status: 500, body: '' }));
    });

    if (upstreamRes.status === 200 && upstreamRes.body) {
      try {
        const parsed = JSON.parse(upstreamRes.body);
        if (parsed.success && parsed.batches) {
          for (const b of parsed.batches) {
            if (!b.previewImage || !b.previewImage.startsWith('http') || b.previewImage.trim() === '') {
              b.previewImage = ICON_URL;
            }
          }
          const modified = transformText(JSON.stringify(parsed));
          res.setHeader('Content-Type', 'application/json');
          return res.status(200).send(modified);
        }
      } catch {
        // Fall through
      }
      const modified = transformText(upstreamRes.body);
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(modified);
    }
  } catch (err) {
    console.warn('Upstream searchBatch fetch error:', err);
  }

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    success: true,
    batches: [],
    totalPages: 1,
    currentPage: 1,
    total: 0,
  });
});

// Helper to determine exact destination path (handles local dev and Vercel serverless rewrites)
function resolvePath(req: express.Request): string {
  // 1. Check query parameter __path (if passed via Vercel rewrite)
  if (req.query.__path && typeof req.query.__path === 'string') {
    let p = req.query.__path;
    if (!p.startsWith('/')) p = `/${p}`;
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (key !== '__path' && value !== undefined) {
        if (Array.isArray(value)) {
          value.forEach((v) => searchParams.append(key, String(v)));
        } else {
          searchParams.append(key, String(value));
        }
      }
    }
    const qs = searchParams.toString();
    return qs ? `${p}?${qs}` : p;
  }

  // 2. Check Vercel matched path headers
  const matched =
    (req.headers['x-matched-path'] as string) ||
    (req.headers['x-vercel-matched-path'] as string) ||
    '';
  if (matched && !matched.startsWith('/api/index') && matched !== '/api') {
    const orig = req.originalUrl || req.url || '';
    const qIndex = orig.indexOf('?');
    const queryString = qIndex !== -1 ? orig.slice(qIndex) : '';
    return matched.includes('?') ? matched : `${matched}${queryString}`;
  }

  // 3. Normal request path (strip serverless prefix if present)
  let target = req.originalUrl || req.url || '/';
  if (target.startsWith('/api/index')) {
    target = target.replace(/^\/api\/index/, '') || '/';
  }
  return target;
}

// Proxy handler for all requests with transparent auto-retry
async function handleProxy(
  req: express.Request,
  res: express.Response,
  overridePath?: string,
  isRetry = false
) {
  const targetPath = overridePath || resolvePath(req);
  const targetUrl = new URL(targetPath, TARGET_ORIGIN);

  // 1. High-speed 0ms memory cache for static JS/CSS assets (immutable)
  if (targetPath.startsWith('/_next/static/')) {
    const cachedStatic = staticAssetCache.get(targetPath);
    if (cachedStatic) {
      res.writeHead(200, {
        ...cachedStatic.headers,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-cache': 'HIT',
      });
      return res.end(cachedStatic.body);
    }
  }

  // 2. High-speed 0ms memory cache for pages and Next.js RSC components (Batches, NextToppers, MissionJeet)
  const isPageOrRsc =
    req.method === 'GET' &&
    (targetPath.startsWith('/study/') || targetPath === '/' || targetPath.includes('_rsc='));
  const pageCacheKey = `${targetPath}:${req.headers['rsc'] || '0'}`;

  if (isPageOrRsc) {
    const cachedPage = pageCache.get(pageCacheKey);
    if (cachedPage && Date.now() - cachedPage.timestamp < CACHE_TTL_MS) {
      res.writeHead(200, {
        ...cachedPage.headers,
        'x-cache': 'HIT',
      });
      return res.end(cachedPage.body);
    }
  }

  // Construct intelligent Referer header
  let refererHeader = `${TARGET_ORIGIN}/`;
  const incomingReferer = (req.headers['referer'] as string) || '';

  if (incomingReferer) {
    try {
      const u = new URL(incomingReferer);
      u.protocol = 'https:';
      u.host = TARGET_HOST;
      refererHeader = u.toString();
    } catch {
      refererHeader = `${TARGET_ORIGIN}/`;
    }
  }

  // Critical requirement: Video endpoints require exact watch path referer with query params
  if (
    targetPath.startsWith('/api/video-url') ||
    targetPath.startsWith('/api/get-video-url') ||
    targetPath.startsWith('/api/Schedule') ||
    targetPath.startsWith('/api/play') ||
    targetPath.startsWith('/api/get-otp')
  ) {
    const q = targetUrl.searchParams;
    const batchId =
      q.get('batch_id') ||
      q.get('batchId') ||
      q.get('BatchId') ||
      '';
    const subjectId =
      q.get('subject_id') ||
      q.get('subjectId') ||
      q.get('SubjectId') ||
      '';
    const videoId =
      q.get('video_id') ||
      q.get('videoId') ||
      q.get('childId') ||
      q.get('ChildId') ||
      q.get('contentId') ||
      q.get('ContentId') ||
      '';
    if (batchId || subjectId || videoId) {
      refererHeader = `${TARGET_ORIGIN}/watch?batchId=${batchId}&SubjectId=${subjectId}&ContentId=${videoId}`;
    } else {
      refererHeader = `${TARGET_ORIGIN}/watch`;
    }
  }

  // Ensure full-access session cookie is attached so upstream key generation is bypassed
  const accessCookie = await getAccessCookie();
  const incomingCookie = (req.headers['cookie'] as string) || '';
  const mergedCookies = [accessCookie];
  if (incomingCookie) {
    const filteredIncoming = incomingCookie
      .split(';')
      .map((c) => c.trim())
      .filter((c) => !c.startsWith('studymeta_access='));
    if (filteredIncoming.length > 0) {
      mergedCookies.push(...filteredIncoming);
    }
  }

  const forwardHeaders: http.OutgoingHttpHeaders = {
    ...req.headers,
    host: TARGET_HOST,
    origin: TARGET_ORIGIN,
    referer: refererHeader,
    cookie: mergedCookies.join('; '),
    'user-agent':
      (req.headers['user-agent'] as string) ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };

  // Strip hop-by-hop headers
  delete forwardHeaders['connection'];
  delete forwardHeaders['keep-alive'];
  delete forwardHeaders['transfer-encoding'];
  delete forwardHeaders['x-matched-path'];

  // Check if this request is a video stream, manifest, DRM OTP, or media segment
  const isDirectMedia =
    targetPath.startsWith('/api/play') ||
    targetPath.startsWith('/api/get-otp') ||
    targetPath.startsWith('/api/video-url') ||
    targetPath.startsWith('/api/Schedule') ||
    targetPath.includes('.mpd') ||
    targetPath.includes('.m3u8') ||
    targetPath.includes('.m4s') ||
    targetPath.includes('.mp4');

  const proxyReq = https.request(
    targetUrl,
    {
      method: req.method,
      headers: forwardHeaders,
      agent: keepAliveAgent,
    },
    (proxyRes) => {
      const statusCode = proxyRes.statusCode || 200;
      const headers = { ...proxyRes.headers };

      // If upstream ever attempts to redirect to key-generate, auto-refresh token and retry transparently
      if (
        (statusCode === 307 || statusCode === 308) &&
        headers['location'] &&
        headers['location'].includes('key-generate') &&
        !isRetry
      ) {
        console.log(
          `[Proxy] Upstream requested key-generate for ${targetPath}. Refreshing token and retrying...`
        );
        cachedAccessCookie = '';
        proxyRes.resume();
        fetchFreshAccessCookie().then(() => {
          handleProxy(req, res, overridePath, true);
        });
        return;
      }

      // Remove framing/CSP restrictions to allow embedding in preview
      delete headers['x-frame-options'];
      delete headers['content-security-policy'];
      delete headers['content-security-policy-report-only'];

      // Allow CORS from any origin for media & API requests
      headers['access-control-allow-origin'] = '*';
      headers['access-control-allow-methods'] = 'GET, POST, OPTIONS, HEAD';
      headers['access-control-allow-headers'] = '*';

      // Always set the full-access cookie on client so the browser stays authenticated
      if (accessCookie) {
        const clientAccessSet = `${accessCookie}; Path=/; SameSite=Lax; Max-Age=86400`;
        if (headers['set-cookie']) {
          const sc = Array.isArray(headers['set-cookie'])
            ? headers['set-cookie']
            : [headers['set-cookie']];
          headers['set-cookie'] = [clientAccessSet, ...sc];
        } else {
          headers['set-cookie'] = [clientAccessSet];
        }
      }

      // Rewrite cookies to work without strict domain pinning
      if (headers['set-cookie']) {
        const cookies = Array.isArray(headers['set-cookie'])
          ? headers['set-cookie']
          : [headers['set-cookie']];
        headers['set-cookie'] = cookies.map((c) =>
          c.replace(/domain=[^;]+;?/gi, '').replace(/Secure;?/gi, '')
        );
      }

      // Rewrite redirect Location to relative, and bypass any key-generate redirect!
      if (headers['location']) {
        let loc = headers['location'].replace(
          /https?:\/\/(www\.)?learnxpw\.site/gi,
          ''
        );

        if (loc.includes('key-generate')) {
          try {
            const locUrl = new URL(headers['location'], TARGET_ORIGIN);
            const redirectParam = locUrl.searchParams.get('redirect') || '/study/batches';
            if (redirectParam === targetPath || redirectParam === req.url) {
              loc = '/study/batches';
            } else {
              loc = redirectParam;
            }
          } catch {
            loc = '/study/batches';
          }
        }
        headers['location'] = loc;
      }

      const contentType = (headers['content-type'] || '').toLowerCase();

      // Only transform UI text (HTML, RSC components, search/batch listings, static scripts)
      const isText =
        !isDirectMedia &&
        (contentType.includes('text/html') ||
          contentType.includes('application/x-javascript') ||
          contentType.includes('application/javascript') ||
          contentType.includes('text/javascript') ||
          contentType.includes('text/x-component') ||
          (contentType.includes('application/json') && !targetPath.startsWith('/api/play')));

      if (!isText) {
        // Stream binary responses and media segments directly at maximum wire speed
        res.writeHead(statusCode, headers);
        proxyRes.pipe(res);
        return;
      }

      // Buffer text responses for string substitution
      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk) => {
        chunks.push(chunk);
      });

      proxyRes.on('end', () => {
        try {
          const rawBuffer = Buffer.concat(chunks);
          let decompressedBuffer = rawBuffer;
          const encoding = (headers['content-encoding'] || '').toLowerCase();

          if (encoding === 'gzip') {
            decompressedBuffer = zlib.gunzipSync(rawBuffer);
          } else if (encoding === 'br') {
            decompressedBuffer = zlib.brotliDecompressSync(rawBuffer);
          } else if (encoding === 'deflate') {
            decompressedBuffer = zlib.inflateSync(rawBuffer);
          }

          const originalText = decompressedBuffer.toString('utf-8');
          const modifiedText = transformText(originalText);
          const outputBuffer = Buffer.from(modifiedText, 'utf-8');

          delete headers['content-encoding'];
          delete headers['transfer-encoding'];
          headers['content-length'] = String(outputBuffer.length);

          if (contentType.includes('text/html')) {
            headers['cache-control'] = 'no-cache, no-store, must-revalidate';
            delete headers['etag'];
          }

          if (targetPath.startsWith('/_next/static/') && statusCode === 200) {
            headers['cache-control'] = 'public, max-age=31536000, immutable';
            staticAssetCache.set(targetPath, {
              body: outputBuffer,
              headers: { ...headers },
            });
          }

          if (isPageOrRsc && statusCode === 200) {
            pageCache.set(pageCacheKey, {
              body: outputBuffer,
              headers: { ...headers },
              timestamp: Date.now(),
            });
          }

          res.writeHead(statusCode, headers);
          res.end(outputBuffer);
        } catch (err) {
          console.error('Error modifying text response:', err);
          const rawBuffer = Buffer.concat(chunks);
          delete headers['transfer-encoding'];
          headers['content-length'] = String(rawBuffer.length);
          res.writeHead(statusCode, headers);
          res.end(rawBuffer);
        }
      });
    }
  );

  proxyReq.on('error', (err) => {
    console.error('Proxy request error:', err);
    if (!res.headersSent) {
      res.status(502).send(`Proxy Error: ${err.message}`);
    }
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

// Catch-all route to proxy every path
app.use((req, res) => {
  handleProxy(req, res);
});

export default app;
