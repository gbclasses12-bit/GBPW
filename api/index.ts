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
const BRAND_NAME = 'PW Batches - GB STUDY';
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
  'studymeta_access=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzY29wZSI6ImZ1bGwiLCJpYXQiOjE3OTQxNTg0NDQsImV4cCI6MTc5NDI0NDg0NH0.mvjvi_PF4kwhlPruOO8IPv4--b1NlYsFvwRXmyxSaKY';
let refreshPromise: Promise<string> | null = null;

// Rotating realistic Indian residential ISP IP generator to bypass cloud/datacenter IP blocks & rate limits
function getRotatingIndianIp(): string {
  const isps = [
    () => `49.36.${Math.floor(Math.random() * 200 + 10)}.${Math.floor(Math.random() * 250 + 1)}`, // Jio 4G/5G
    () => `49.37.${Math.floor(Math.random() * 200 + 10)}.${Math.floor(Math.random() * 250 + 1)}`, // Jio Fiber
    () => `106.192.${Math.floor(Math.random() * 250 + 1)}.${Math.floor(Math.random() * 250 + 1)}`, // Airtel Broadband
    () => `122.161.${Math.floor(Math.random() * 250 + 1)}.${Math.floor(Math.random() * 250 + 1)}`, // Airtel 4G/5G
    () => `103.21.124.${Math.floor(Math.random() * 250 + 1)}`, // ACT Fibernet
    () => `117.192.${Math.floor(Math.random() * 250 + 1)}.${Math.floor(Math.random() * 250 + 1)}`, // BSNL Broadband
  ];
  return isps[Math.floor(Math.random() * isps.length)]();
}

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

// Persistent Offline Storage to survive upstream limits, IP blocks, and full shutdowns
interface OfflineStorageSchema {
  allBatches: Record<string, string>;
  batchInfo: Record<string, string>;
  subjectInfo: Record<string, string>;
  topicInfo: Record<string, string>;
  schedules: Record<string, any>;
  pages: Record<string, string>;
}

const offlineStorage: OfflineStorageSchema = {
  allBatches: {},
  batchInfo: {},
  subjectInfo: {},
  topicInfo: {},
  schedules: {},
  pages: {},
};

function getStorageFilePath(): string {
  const localPath = path.resolve(process.cwd(), 'data', 'offline_storage.json');
  if (fs.existsSync(localPath)) return localPath;
  const tmpPath = '/tmp/offline_storage.json';
  if (fs.existsSync(tmpPath)) return tmpPath;
  return localPath;
}

function loadOfflineStorage() {
  try {
    const filePath = getStorageFilePath();
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed.allBatches) Object.assign(offlineStorage.allBatches, parsed.allBatches);
      if (parsed.batchInfo) Object.assign(offlineStorage.batchInfo, parsed.batchInfo);
      if (parsed.subjectInfo) Object.assign(offlineStorage.subjectInfo, parsed.subjectInfo);
      if (parsed.topicInfo) Object.assign(offlineStorage.topicInfo, parsed.topicInfo);
      if (parsed.schedules) Object.assign(offlineStorage.schedules, parsed.schedules);
      if (parsed.pages) Object.assign(offlineStorage.pages, parsed.pages);
      console.log(
        `[OfflineStorage] Loaded ${Object.keys(offlineStorage.allBatches).length} batch pages, ` +
        `${Object.keys(offlineStorage.batchInfo).length} batch details, ` +
        `${Object.keys(offlineStorage.pages).length} pages into memory.`
      );
    }
  } catch (err) {
    console.warn('[OfflineStorage] Error reading offline storage:', err);
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSaveOfflineStorage() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const dataDir = path.resolve(process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const primaryPath = path.resolve(dataDir, 'offline_storage.json');
      fs.writeFileSync(primaryPath, JSON.stringify(offlineStorage), 'utf-8');
    } catch {
      try {
        fs.writeFileSync('/tmp/offline_storage.json', JSON.stringify(offlineStorage), 'utf-8');
      } catch {}
    }
  }, 3000);
}

// Pre-load saved offline records on boot
loadOfflineStorage();

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

// Proactively keep session token alive 24/7 by refreshing every 6 hours (only in long-running servers, skip in serverless)
if (!process.env.VERCEL) {
  setInterval(async () => {
    try {
      console.log('[Heartbeat] Proactively refreshing session token...');
      await fetchFreshAccessCookie();
    } catch (err) {
      console.warn('[Heartbeat] Proactive token refresh error:', err);
    }
  }, 6 * 60 * 60 * 1000);
}

async function fetchFreshAccessCookie(): Promise<string> {
  try {
    const anonId = 'anon_' + Date.now();
    const fakeIp = getRotatingIndianIp();
    const pageData = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const getReq = https.get(
        `${TARGET_ORIGIN}/key-generate?redirect=%2Fstudy%2Fbatches&type=full&anon_id=${anonId}`,
        {
          headers: {
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            referer: `${TARGET_ORIGIN}/study/batches`,
            cookie: `anon_id=${anonId}`,
            'x-forwarded-for': fakeIp,
            'x-real-ip': fakeIp,
            'cf-connecting-ip': fakeIp,
            'client-ip': fakeIp,
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

    // Multi-pattern token regex handling raw unescaped, JSON-escaped, and React-escaped tokens
    const m =
      pageData.body.match(/token(?:\\*")?\s*:\s*(?:\\*")?([A-Za-z0-9+/=:+_-]{20,})/) ||
      pageData.body.match(/"token":\s*"([^"]+)"/) ||
      pageData.body.match(/\\?"token\\?":\s*\\?"([^"\\]+)\\?"/);

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
            'x-forwarded-for': fakeIp,
            'x-real-ip': fakeIp,
            'cf-connecting-ip': fakeIp,
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
 * Searches across persistent offline topics for a lecture's metadata
 */
function findLectureInOfflineTopics(contentId: string): any | null {
  if (!contentId) return null;
  for (const raw of Object.values(offlineStorage.topicInfo)) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const list = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : [];
      for (const item of list) {
        if (
          item &&
          (item._id === contentId ||
            item.id === contentId ||
            item.videoDetails?._id === contentId ||
            item.videoDetails?.id === contentId ||
            item.videoDetails?.findKey === contentId)
        ) {
          return item;
        }
      }
    } catch {}
  }
  return null;
}

/**
 * Executes an HTTP GET request to upstream with the valid access cookie and rotating Indian residential IP.
 * Automatically refreshes the session token and retries if upstream reports unauthorized, rate-limited, or redirects.
 */
async function fetchWithAuth(
  url: string,
  referer: string
): Promise<{ status: number; body: string }> {
  let cookie = await getAccessCookie();

  const doRequest = (c: string) => {
    const fakeIp = getRotatingIndianIp();
    return new Promise<{ status: number; body: string }>((resolve) => {
      const req = https.get(
        url,
        {
          headers: {
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            referer,
            cookie: c,
            'x-forwarded-for': fakeIp,
            'x-real-ip': fakeIp,
            'cf-connecting-ip': fakeIp,
            'client-ip': fakeIp,
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
  };

  let res = await doRequest(cookie);

  if (
    res.status === 401 ||
    res.status === 403 ||
    res.status === 429 ||
    res.status === 307 ||
    (res.body && (res.body.includes('Unauthorised') || res.body.includes('key-generate')))
  ) {
    console.log(`Auth invalidated or rate-limited on ${url}, refreshing token and retrying with fresh IP...`);
    cachedAccessCookie = '';
    cookie = await fetchFreshAccessCookie();
    res = await doRequest(cookie);
  }

  return res;
}

// Background pre-warmer and archiver to keep essential pages and batches stored offline
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
        offlineStorage.pages[p] = modified;
        if (p === '/study/batches') {
          offlineStorage.pages['/'] = modified;
        }
      }
    } catch {
      // Ignore background prewarm errors
    }
  }

  // Also prewarm batch catalog pages 1 to 5 to ensure persistent cache is always complete
  for (let pageNum = 1; pageNum <= 5; pageNum++) {
    try {
      const res = await fetchWithAuth(
        `${TARGET_ORIGIN}/api/AllBatches?page=${pageNum}`,
        `${TARGET_ORIGIN}/study/batches`
      );
      if (res.status === 200 && res.body) {
        const parsed = JSON.parse(res.body);
        if (parsed.success && parsed.batches) {
          for (const b of parsed.batches) {
            if (!b.previewImage || !b.previewImage.startsWith('http') || b.previewImage.trim() === '') {
              b.previewImage = ICON_URL;
            }
          }
          const modified = transformText(JSON.stringify(parsed));
          offlineStorage.allBatches[String(pageNum)] = modified;
        }
      }
    } catch {}
  }

  // Prewarm primary batch subjects and topic lectures for offline resilience
  try {
    const page1Str = offlineStorage.allBatches['1'];
    if (page1Str) {
      const p1 = JSON.parse(page1Str);
      const topBatches = (p1.batches || []).slice(0, 3);
      for (const b of topBatches) {
        if (!b._id) continue;
        const bRes = await fetchWithAuth(
          `${TARGET_ORIGIN}/api/BatchInfo?BatchId=${b._id}&Type=details`,
          `${TARGET_ORIGIN}/study/batches/${b._id}`
        );
        if (bRes.status === 200 && bRes.body) {
          offlineStorage.batchInfo[`${b._id}:details:1`] = transformText(bRes.body);
          const bData = JSON.parse(bRes.body);
          const subjects = (bData.data?.subjects || []).slice(0, 4);
          for (const s of subjects) {
            if (!s._id) continue;
            const sRes = await fetchWithAuth(
              `${TARGET_ORIGIN}/api/SubjectInfo?BatchId=${b._id}&SubjectId=${s._id}&page=1`,
              `${TARGET_ORIGIN}/study/batches/${b._id}`
            );
            if (sRes.status === 200 && sRes.body) {
              offlineStorage.subjectInfo[`${b._id}:${s._id}:1`] = transformText(sRes.body);
              const sData = JSON.parse(sRes.body);
              const topics = (sData.data || []).slice(0, 2);
              for (const t of topics) {
                if (!t._id) continue;
                for (const cType of ['videos', 'notes', 'dppNotes']) {
                  const tRes = await fetchWithAuth(
                    `${TARGET_ORIGIN}/api/TopicInfo?BatchId=${b._id}&SubjectId=${s._id}&TopicId=${t._id}&ContentType=${cType}&page=1`,
                    `${TARGET_ORIGIN}/study/batches/${b._id}`
                  );
                  if (tRes.status === 200 && tRes.body) {
                    offlineStorage.topicInfo[`${b._id}:${s._id}:${t._id}:${cType}:1`] = transformText(tRes.body);
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch {}

  scheduleSaveOfflineStorage();
}

// Pre-warm on server boot (delayed 1s) and every 10 minutes (skip in serverless)
if (!process.env.VERCEL) {
  setTimeout(prewarmEssentialPages, 1000);
  setInterval(prewarmEssentialPages, 10 * 60 * 1000);
}

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


  // PW Batches dedicated sidebar rules
  text = text.replaceAll(/<a href="\/study\/nexttoppers"[^>]*>[\s\S]*?<\/a>/g, '');
  text = text.replaceAll(/<a href="\/study\/missionjeet"[^>]*>[\s\S]*?<\/a>/g, '');
  text = text.replaceAll(/<a href="\/study\/vibrant"[^>]*>[\s\S]*?<\/a>/g, '');
  text = text.replaceAll(/<a href="\/study\/sway"[^>]*>[\s\S]*?<\/a>/g, '');
  text = text.replaceAll(/<a href="\/study\/pi"[^>]*>[\s\S]*?<\/a>/g, '');

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

  function fixLivePlayerStalls() {
    try {
      var vids = document.querySelectorAll('video');
      vids.forEach(function(v) {
        if (!v.dataset.pwLiveEnhanced) {
          v.dataset.pwLiveEnhanced = '1';
          v.preload = 'auto';

          var stallCount = 0;
          var checkResume = function() {
            if (v.paused && !v.ended && v.readyState >= 2) {
              v.play().catch(function(){});
            }
          };

          v.addEventListener('stalled', function() {
            stallCount++;
            if (stallCount >= 2 && v.buffered.length > 0) {
              var liveEdge = v.buffered.end(v.buffered.length - 1);
              if (Math.abs(v.currentTime - liveEdge) > 2) {
                v.currentTime = Math.max(0, liveEdge - 0.5);
              }
              v.play().catch(function(){});
              stallCount = 0;
            }
          });

          v.addEventListener('waiting', function() {
            setTimeout(checkResume, 2000);
          });

          v.addEventListener('error', function() {
            setTimeout(function() {
              if (v.src) {
                var s = v.src;
                v.src = '';
                v.src = s;
                v.load();
                v.play().catch(function(){});
              }
            }, 2500);
          });
        }
      });

      // Auto-poll if on watch page and live stream hasn't started yet
      if (typeof window !== 'undefined' && window.location.pathname.indexOf('/watch') !== -1) {
        var vid = document.querySelector('video');
        var isWaiting = !vid || (!vid.src && (!vid.querySelector('source') || !vid.querySelector('source').src));
        if (isWaiting && !window.__pwLivePollTimer) {
          window.__pwLivePollTimer = setInterval(function() {
            var currVid = document.querySelector('video');
            if (currVid && (currVid.src || (currVid.querySelector('source') && currVid.querySelector('source').src))) {
              clearInterval(window.__pwLivePollTimer);
              window.__pwLivePollTimer = null;
              return;
            }
            if (window.location.search) {
              fetch('/api/Schedule' + window.location.search)
                .then(function(r) { return r.json(); })
                .then(function(data) {
                  if (data && data.data && data.data.url) {
                    clearInterval(window.__pwLivePollTimer);
                    window.__pwLivePollTimer = null;
                    window.location.reload();
                  }
                })
                .catch(function(){});
            }
          }, 6000);
        }
      }
    } catch(e) {}
  }


  try {
    if (!document.querySelector('#gb-platform-clean')) {
      var st = document.createElement('style');
      st.id = 'gb-platform-clean';
      st.textContent = 'a[data-gb-downloads="1"], #gb-downloads-btn, a[href*="download"], a[href*="zips"], a[href*="/study/pi"], a[href$="/pi"], a[href*="/study/nexttoppers"], a[href*="/study/missionjeet"], a[href*="/study/vibrant"], a[href*="/study/sway"] { display: none !important; }';
      (document.head || document.documentElement).appendChild(st);
    }
  } catch(e) {}

  function fixPlatformSidebar() {
    try {
      var targetPlatform = 'batches';
      var allNavs = document.querySelectorAll('nav');
      allNavs.forEach(function(nav) {
        var links = nav.querySelectorAll('a');
        links.forEach(function(a) {
          var h = a.getAttribute('href') || '';
          var txt = (a.textContent || '').trim().toLowerCase();

          // Permanently hide and remove any downloads button or link so nobody can steal the website code
          if (a.getAttribute('data-gb-downloads') === '1' || h.includes('download') || h.includes('zip') || txt.includes('platform zip') || txt.includes('download')) {
            a.remove();
            return;
          }

          // Hide and remove duplicate PI
          if (txt === 'pi' || h.includes('/study/pi') || h.endsWith('/pi')) {
            a.remove();
            return;
          }

          // Hide PW BOOKS on dedicated platform sites (only allow on pw-batches)
          if (a.getAttribute('data-pw-books') === '1' || txt.includes('pw books') || h.includes('gb-study-1')) {
            if (targetPlatform !== 'batches') {
              a.remove();
              return;
            }
          }

          if (h.includes('/study/nexttoppers')) {
            if (targetPlatform === 'nexttoppers') {
              var sp = a.querySelector('span');
              if (sp) sp.textContent = 'Batches';
            } else {
              a.remove();
            }
          } else if (h.includes('/study/missionjeet')) {
            if (targetPlatform === 'missionjeet') {
              var sp = a.querySelector('span');
              if (sp) sp.textContent = 'Batches';
            } else {
              a.remove();
            }
          } else if (h.includes('/study/vibrant')) {
            if (targetPlatform === 'vibrant') {
              var sp = a.querySelector('span');
              if (sp) sp.textContent = 'Batches';
            } else {
              a.remove();
            }
          } else if (h.includes('/study/sway')) {
            if (targetPlatform === 'sway') {
              var sp = a.querySelector('span');
              if (sp) sp.textContent = 'Batches';
            } else {
              a.remove();
            }
          } else if (h.includes('/study/batches')) {
            if (targetPlatform === 'batches') {
              var sp = a.querySelector('span');
              if (sp) sp.textContent = 'Batches';
            } else {
              a.remove();
            }
          }
        });
      });

      // Remove any floating downloads button permanently
      var fb = document.querySelector('#gb-downloads-btn');
      if (fb) fb.remove();
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
    fixPlatformSidebar();
    injectPwBooks();
    injectPoweredBy();
    fixMissingBatchBanners();
    fixLivePlayerStalls();
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

// Resilient /api/Schedule handler: 100% live stream resolution, anti-block, and offline fallback
app.get('/api/Schedule', async (req, res) => {
  const batchId = (req.query.BatchId || req.query.batchId || req.query.batch_id || '') as string;
  const subjectId = (req.query.SubjectId || req.query.subjectId || req.query.subject_id || '') as string;
  const contentId = (req.query.ContentId || req.query.contentId || req.query.ChildId || req.query.childId || req.query.videoId || req.query.video_id || '') as string;

  const watchReferer = `${TARGET_ORIGIN}/watch?batchId=${batchId}&SubjectId=${subjectId}&ContentId=${contentId}`;

  // Helper to ensure live flags are properly set so video player loads live stream seamlessly
  const enrichLiveSchedule = (schedData: any) => {
    if (!schedData) return;
    const isLive =
      schedData.status === 'LIVE' ||
      schedData.liveStatus === 'LIVE' ||
      schedData.lectureType === 'LIVE' ||
      schedData.isLive === true ||
      (schedData.startTime && !schedData.endTime);

    if (isLive) {
      schedData.isLive = true;
      schedData.status = 'LIVE';
      schedData.liveStatus = 'LIVE';
      schedData.lectureType = 'LIVE';
      schedData.isChatEnabled = true;
      if (!schedData.videoDetails) schedData.videoDetails = {};
      schedData.videoDetails.isLive = true;
      schedData.videoDetails.status = 'LIVE';
      if (!schedData.videoDetails.types || schedData.videoDetails.types.length === 0) {
        schedData.videoDetails.types = ['DASH', 'HLS'];
      }
    }
    if (schedData.url && (!schedData.videoDetails || !schedData.videoDetails.videoUrl)) {
      if (!schedData.videoDetails) schedData.videoDetails = {};
      schedData.videoDetails.videoUrl = schedData.url;
    } else if (schedData.videoDetails?.videoUrl && !schedData.url) {
      schedData.url = schedData.videoDetails.videoUrl;
    }
  };

  // 1. Attempt to fetch schedule from upstream with fetchWithAuth (auto-token refresh + rotating residential IP)
  try {
    const upstreamUrl = `${TARGET_ORIGIN}/api/Schedule?BatchId=${encodeURIComponent(batchId)}&SubjectId=${encodeURIComponent(subjectId)}&ContentId=${encodeURIComponent(contentId)}`;
    const upstreamRes = await fetchWithAuth(upstreamUrl, watchReferer);

    if (upstreamRes.status === 200 && upstreamRes.body) {
      try {
        const parsed = JSON.parse(upstreamRes.body);
        const item = Array.isArray(parsed?.data) ? parsed.data[0] : parsed?.data;
        if (parsed.success && item) {
          enrichLiveSchedule(item);

          // If stream URL is empty, query multi-source endpoints (/api/video-url, /api/get-video-url, /api/play)
          if (!item.url || item.url.trim() === '') {
            try {
              const vUrls = [
                `${TARGET_ORIGIN}/api/video-url?batch_id=${encodeURIComponent(batchId)}&subject_id=${encodeURIComponent(subjectId)}&video_id=${encodeURIComponent(contentId)}`,
                `${TARGET_ORIGIN}/api/get-video-url?batch_id=${encodeURIComponent(batchId)}&subject_id=${encodeURIComponent(subjectId)}&video_id=${encodeURIComponent(contentId)}`,
                `${TARGET_ORIGIN}/api/play?id=${encodeURIComponent(contentId)}`,
              ];
              for (const endpoint of vUrls) {
                const vRes = await fetchWithAuth(endpoint, watchReferer);
                if (vRes.status === 200 && vRes.body) {
                  const vParsed = JSON.parse(vRes.body);
                  const streamUrl = vParsed.data?.url || vParsed.data?.videoUrl || vParsed.url;
                  if (streamUrl) {
                    item.url = streamUrl;
                    if (vParsed.data?.urlType) item.urlType = vParsed.data.urlType;
                    if (item.videoDetails) item.videoDetails.videoUrl = streamUrl;
                    break;
                  }
                }
              }
            } catch {}
          }

          if (contentId) {
            offlineStorage.schedules[contentId] = parsed;
            scheduleSaveOfflineStorage();
          }
          res.setHeader('Content-Type', 'application/json');
          return res.status(200).json(parsed);
        }
      } catch {}
    }
  } catch (err) {
    console.warn('Upstream /api/Schedule fetch encountered error, checking offline store:', err);
  }

  // 2. Check persistent offline schedule storage
  if (contentId && offlineStorage.schedules[contentId]) {
    const cached = offlineStorage.schedules[contentId];
    const item = Array.isArray(cached?.data) ? cached.data[0] : cached?.data;
    if (item) enrichLiveSchedule(item);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'OFFLINE');
    return res.status(200).json(cached);
  }

  // 3. Search across cached topics to construct schedule for this lecture
  const foundTopicItem = findLectureInOfflineTopics(contentId);
  if (foundTopicItem) {
    const isLive =
      foundTopicItem.status === 'LIVE' ||
      foundTopicItem.liveStatus === 'LIVE' ||
      foundTopicItem.lectureType === 'LIVE' ||
      foundTopicItem.isLive === true;

    const synthesizedSchedule = {
      _id: foundTopicItem._id || contentId,
      topic: foundTopicItem.topic || foundTopicItem.name || 'Class Lecture',
      title: foundTopicItem.topic || foundTopicItem.name || 'Class Lecture',
      name: foundTopicItem.topic || foundTopicItem.name || 'Class Lecture',
      urlType: foundTopicItem.urlType || 'penpencilvdo',
      url: foundTopicItem.url || foundTopicItem.videoDetails?.videoUrl || '',
      status: isLive ? 'LIVE' : (foundTopicItem.status || 'COMPLETED'),
      liveStatus: isLive ? 'LIVE' : (foundTopicItem.status || 'COMPLETED'),
      lectureType: foundTopicItem.lectureType || (isLive ? 'LIVE' : 'RECORDED'),
      isLive: isLive,
      isChatEnabled: true,
      startTime: foundTopicItem.startTime || foundTopicItem.date,
      endTime: foundTopicItem.endTime,
      date: foundTopicItem.date,
      teachers: foundTopicItem.teachers || [],
      tags: foundTopicItem.tags || [],
      videoDetails: {
        _id: foundTopicItem.videoDetails?._id || contentId,
        name: foundTopicItem.topic || foundTopicItem.name || 'Class Lecture',
        videoUrl: foundTopicItem.videoDetails?.videoUrl || foundTopicItem.url || '',
        image: foundTopicItem.videoDetails?.image || ICON_URL,
        duration: foundTopicItem.videoDetails?.duration || '',
        status: isLive ? 'LIVE' : (foundTopicItem.videoDetails?.status || 'Ready'),
        types: foundTopicItem.videoDetails?.types || ['DASH', 'HLS'],
        isLive: isLive,
      },
      availableFor: [],
      platformRestricted: false,
      restrictedSchedule: false,
      restrictedTime: 0,
    };
    offlineStorage.schedules[contentId] = { success: true, data: synthesizedSchedule };
    scheduleSaveOfflineStorage();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'OFFLINE-TOPIC');
    return res.status(200).json({ success: true, data: synthesizedSchedule });
  }

  // 4. Query video-url or synthesize resilient schedule structure so watch player never crashes
  let urlType = 'penpencilvdo';
  let videoUrl = '';
  const topic = 'Class Lecture';

  try {
    const vUrl = `${TARGET_ORIGIN}/api/video-url?batch_id=${encodeURIComponent(batchId)}&subject_id=${encodeURIComponent(subjectId)}&video_id=${encodeURIComponent(contentId)}`;
    const vRes = await fetchWithAuth(vUrl, watchReferer);
    if (vRes.status === 200 && vRes.body) {
      const vParsed = JSON.parse(vRes.body);
      if (vParsed.success && vParsed.data) {
        urlType = vParsed.data.urlType || 'penpencilvdo';
        videoUrl = vParsed.data.url || '';
      }
    }
  } catch {}

  const fallbackData = {
    _id: contentId,
    topic: topic,
    title: topic,
    name: topic,
    urlType: urlType,
    url: videoUrl,
    status: 'LIVE',
    liveStatus: 'LIVE',
    lectureType: 'LIVE',
    isLive: true,
    isChatEnabled: true,
    videoDetails: {
      _id: contentId,
      name: topic,
      videoUrl: videoUrl,
      status: 'LIVE',
      isLive: true,
      types: ['DASH', 'HLS'],
    },
    availableFor: [],
    platformRestricted: false,
    restrictedSchedule: false,
    restrictedTime: 0,
  };

  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    success: true,
    data: fallbackData,
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
          offlineStorage.allBatches[page] = modified;
          scheduleSaveOfflineStorage();
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

  // Persistent offline fallback: guarantees batches are displayed even during complete upstream shutdown
  const offlineBatches = offlineStorage.allBatches[page] || offlineStorage.allBatches['1'];
  if (offlineBatches) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'OFFLINE');
    return res.status(200).send(offlineBatches);
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
          offlineStorage.batchInfo[cacheKey] = modified;
          scheduleSaveOfflineStorage();
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

  if (offlineStorage.batchInfo[cacheKey]) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'OFFLINE');
    return res.status(200).send(offlineStorage.batchInfo[cacheKey]);
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
          offlineStorage.subjectInfo[cacheKey] = modified;
          scheduleSaveOfflineStorage();
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

  if (offlineStorage.subjectInfo[cacheKey]) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'OFFLINE');
    return res.status(200).send(offlineStorage.subjectInfo[cacheKey]);
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
          offlineStorage.topicInfo[cacheKey] = modified;
          scheduleSaveOfflineStorage();
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

  if (offlineStorage.topicInfo[cacheKey]) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'OFFLINE');
    return res.status(200).send(offlineStorage.topicInfo[cacheKey]);
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

  const fakeIp = getRotatingIndianIp();
  const forwardHeaders: http.OutgoingHttpHeaders = {
    ...req.headers,
    host: TARGET_HOST,
    origin: TARGET_ORIGIN,
    referer: refererHeader,
    cookie: mergedCookies.join('; '),
    'user-agent':
      (req.headers['user-agent'] as string) ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'x-forwarded-for': (req.headers['x-forwarded-for'] as string) || fakeIp,
    'x-real-ip': fakeIp,
    'cf-connecting-ip': fakeIp,
    'client-ip': fakeIp,
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

      // If upstream ever attempts to redirect to key-generate, or responds with 401/403/429, auto-refresh token and retry
      if (
        !isRetry &&
        (((statusCode === 307 || statusCode === 308) &&
          headers['location'] &&
          headers['location'].includes('key-generate')) ||
          statusCode === 401 ||
          statusCode === 403 ||
          statusCode === 429)
      ) {
        console.log(
          `[Proxy] Upstream returned ${statusCode} for ${targetPath}. Refreshing token and retrying with fresh residential IP...`
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
            if (contentType.includes('text/html')) {
              offlineStorage.pages[targetPath] = modifiedText;
              if (targetPath.startsWith('/study/batches')) {
                offlineStorage.pages['/'] = modifiedText;
                offlineStorage.pages['/study/batches'] = modifiedText;
              }
              scheduleSaveOfflineStorage();
            }
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
    console.warn(`Upstream connection error on ${targetPath}:`, err.message);
    if (res.headersSent) return;

    // 1. If HTML page request and upstream is down/blocked, serve offline HTML page shell
    const cachedPage =
      offlineStorage.pages[targetPath] ||
      offlineStorage.pages['/study/batches'] ||
      offlineStorage.pages['/'];
    if (
      cachedPage &&
      (targetPath.startsWith('/study/') || targetPath === '/' || !targetPath.includes('.'))
    ) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-offline-fallback': '1',
      });
      return res.end(cachedPage);
    }

    // 2. If API request and upstream is dead/blocked, return graceful JSON
    if (targetPath.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Offline-Fallback', '1');
      return res.status(200).json({ success: true, data: [], offline: true });
    }

    res.status(502).send(`Proxy Error: ${err.message}`);
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
