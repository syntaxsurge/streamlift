import { busyStates, publicUrl, supportedPage, filenameFor, originPattern } from './common.js';

const queues = new Map();
let creatingOffscreen;
const offscreenUrl = chrome.runtime.getURL('offscreen.html');
const popupUrl = chrome.runtime.getURL('popup.html');

function serial(tabId, work) {
  const previous = queues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  queues.set(tabId, next);
  next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
  return next;
}

async function readState(tabId, pageUrl = '') {
  const key = 'tab:' + tabId;
  const stored = (await chrome.storage.session.get(key))[key];
  return stored || { tabId, pageUrl, frames: {}, job: null };
}

function snapshot(state) {
  const sources = [];
  const top = state.frames[0];
  for (const frame of Object.values(state.frames)) {
    if (frame !== top && top && !(top.frameUrls || []).includes(frame.pageUrl)) continue;
    // Parent-declared sources take precedence over the label reported by an embed.
    for (const source of frame.sources) {
      if (!sources.some(item => item.url === source.url)) sources.push(source);
    }
  }
  return { sources, job: state.job, selectedEmbedUrl: top?.selectedEmbedUrl || null };
}

async function writeState(state) {
  await chrome.storage.session.set({ ['tab:' + state.tabId]: state });
  chrome.tabs.sendMessage(state.tabId, { type: 'STATE_UPDATE', ...snapshot(state) }, { frameId: 0 }).catch(() => {});
  chrome.runtime.sendMessage({ target: 'popup', type: 'STATE_UPDATE', tabId: state.tabId }).catch(() => {});
  return snapshot(state);
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'],
      justification: 'Assemble video segments into a downloadable file and retain its Blob until saving finishes.' })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function offscreen(message) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

async function launchHls(state, source) {
  state.job.sourceUrl = source.url;
  state.job.kind = 'hls';
  state.job.downloadId = null;
  state.job.state = 'starting';
  state.job.progress = null;
  state.job.message = 'Reading the highest-quality video playlist…';
  await writeState(state);
  await ensureOffscreen();
  const reply = await offscreen({ type: 'RUN_HLS', tabId: state.tabId, jobId: state.job.id, url: source.url });
  if (!reply?.accepted) throw new Error(reply?.error || 'Unable to start the video download.');
}

async function startDownload(tabId, sourceUrl, title) {
  const state = await readState(tabId);
  if (busyStates.has(state.job?.state)) return { ok: false, error: 'A download is already running on this page.' };
  const sources = snapshot(state).sources;
  const automatic = sourceUrl === 'auto';
  const source = automatic ? sources.find(item => item.kind === 'mp4') || sources[0]
    : sources.find(item => item.url === sourceUrl);
  if (!source) return { ok: false, error: 'Start the video or refresh the page to detect its source.' };
  state.job = { id: crypto.randomUUID(), state: 'starting', message: 'Starting download…',
    title: String(title || state.frames[0]?.title || 'video').slice(0, 300),
    sourceUrl: source.url, kind: source.kind, progress: null, downloadId: null,
    fallback: automatic ? sources.find(item => item.kind === 'hls') || null : null };
  await writeState(state);
  try {
    if (source.kind === 'hls') await launchHls(state, source);
    else {
      state.job.filename = filenameFor(state.job.title, 'mp4');
      const downloadId = await chrome.downloads.download({ url: publicUrl(source.url),
        filename: state.job.filename, conflictAction: 'uniquify', saveAs: false });
      state.job.downloadId = downloadId;
      state.job.state = 'downloading';
      state.job.message = 'Downloading MP4. Progress is available in Chrome downloads.';
      await writeState(state);
      await inspectDownload(state);
    }
  } catch (error) {
    await handleFailure(state, error.message);
  }
  return { ok: true, ...snapshot(state) };
}

async function handleFailure(state, message, allowFallback = true) {
  if (allowFallback && state.job?.kind === 'mp4' && state.job.fallback) {
    const fallback = state.job.fallback;
    state.job.fallback = null;
    try { await launchHls(state, fallback); return; }
    catch (error) { message = error.message; }
  }
  state.job.state = 'error';
  state.job.message = message || 'The server could not provide this video. Try another player.';
  state.job.progress = null;
  await writeState(state);
}

async function inspectDownload(state) {
  const items = await chrome.downloads.search({ id: state.job.downloadId });
  if (!items.length || items[0].state === 'in_progress') return;
  await finishDownload(state, items[0].state, items[0].error, items[0].mime);
}

async function finishDownload(state, status, error, mime) {
  if (!busyStates.has(state.job?.state)) return;
  if (!['complete', 'interrupted'].includes(status)) return;
  if (state.job.kind === 'hls') await offscreen({ type: 'RELEASE', jobId: state.job.id }).catch(() => {});
  if (status === 'complete' && /^(?:text\/|application\/(?:json|xml|xhtml\+xml))/i.test(mime || '')) {
    await handleFailure(state, 'The server returned a text page. Try another player.');
    return;
  }
  if (status === 'complete') {
    state.job.state = 'complete';
    state.job.progress = 100;
    state.job.message = 'Saved ' + state.job.filename;
    state.job.fallback = null;
    await writeState(state);
  } else if (error === 'USER_CANCELED') {
    state.job.state = 'cancelled';
    state.job.message = 'Download cancelled.';
    state.job.fallback = null;
    await writeState(state);
  } else {
    const recoverable = /^(?:NETWORK_|SERVER_)/.test(error || '');
    await handleFailure(state, 'Chrome could not finish the download' + (error ? ' (' + error + ').' : '.'), recoverable);
  }
}

async function findJob(jobId) {
  const values = await chrome.storage.session.get(null);
  return Object.entries(values).find(([key, value]) => key.startsWith('tab:') && value?.job?.id === jobId)?.[1];
}

async function internalMessage(message) {
  const original = await findJob(message.jobId);
  if (!original) return { error: 'Download is no longer active.' };
  return serial(original.tabId, async () => {
    const state = await readState(original.tabId);
    if (state.job?.id !== message.jobId || !busyStates.has(state.job.state)) return { error: 'Download is no longer active.' };
    if (message.type === 'FETCH_ACCESS') {
      const pattern = originPattern(message.url);
      return await chrome.permissions.contains({ origins: [pattern] })
        ? { allowed: true } : { allowed: false, origin: pattern };
    }
    if (message.type === 'HLS_PROGRESS') {
      state.job.state = 'downloading';
      state.job.progress = Number.isFinite(message.progress) ? Math.max(0, Math.min(99, message.progress)) : null;
      state.job.message = String(message.message || 'Downloading video…').slice(0, 250);
    } else if (message.type === 'HLS_READY') {
      const url = new URL(message.url);
      if (url.protocol !== 'blob:' || !message.url.startsWith('blob:chrome-extension://' + chrome.runtime.id + '/')) {
        throw new Error('Invalid assembled video address.');
      }
      const extension = message.extension === 'mp4' ? 'mp4' : 'ts';
      state.job.filename = filenameFor(state.job.title, extension);
      state.job.state = 'saving';
      state.job.progress = 99;
      state.job.message = 'Saving ' + state.job.filename + '…';
      await writeState(state);
      try {
        state.job.downloadId = await chrome.downloads.download({ url: message.url,
          filename: state.job.filename, conflictAction: 'uniquify', saveAs: false });
        await writeState(state);
        await inspectDownload(state);
      } catch (error) {
        await offscreen({ type: 'RELEASE', jobId: state.job.id }).catch(() => {});
        await handleFailure(state, error.message, false);
      }
      return { ok: true };
    } else if (message.type === 'HLS_ERROR') {
      if (message.origin) {
        state.job.state = 'needs_permission';
        state.job.missingOrigin = originPattern(message.origin.replace(/\*$/, ''));
        state.job.message = 'Allow this video host from the extension icon, then try again.';
        state.job.progress = null;
      } else {
        await handleFailure(state, String(message.error || 'Video download failed.'), false);
        return { ok: true };
      }
    } else return { error: 'Unknown download message.' };
    await writeState(state);
    return { ok: true };
  });
}

async function pageMessage(message, sender) {
  const fromPopup = sender.url === popupUrl;
  const tabId = fromPopup ? message.tabId : sender.tab?.id;
  if (!Number.isInteger(tabId)) throw new Error('Open a video page first.');
  if (!fromPopup && (!supportedPage(sender.url) || !supportedPage(sender.tab?.url))) {
    throw new Error('This page is unsupported.');
  }
  return serial(tabId, async () => {
    const state = await readState(tabId, sender.tab?.url);
    if (fromPopup || message.type === 'START_DOWNLOAD') {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url !== state.pageUrl) {
        state.pageUrl = tab.url || '';
        state.frames = {};
        if (!busyStates.has(state.job?.state)) state.job = null;
        await writeState(state);
      }
      if (message.type === 'START_DOWNLOAD' && !supportedPage(tab.url)) {
        throw new Error('Open a supported video page first.');
      }
    }
    if (message.type === 'GET_STATE') return snapshot(state);
    if (message.type === 'DISCOVERED' && !fromPopup) {
      const topUrl = sender.tab.url;
      if (state.pageUrl !== topUrl) {
        state.pageUrl = topUrl;
        state.frames = {};
        if (!busyStates.has(state.job?.state)) state.job = null;
      }
      const sources = (Array.isArray(message.sources) ? message.sources : []).slice(0, 30).flatMap(source => {
        if (!['mp4', 'hls'].includes(source.kind)) return [];
        try { return [{ url: publicUrl(source.url), kind: source.kind,
          label: String(source.label || 'Video').slice(0, 80),
          ...(source.embedUrl ? { embedUrl: publicUrl(source.embedUrl) } : {}) }]; }
        catch { return []; }
      });
      state.frames[sender.frameId] = { pageUrl: sender.url, documentId: sender.documentId,
        title: String(message.title || 'video').slice(0, 300), sources,
        frameUrls: (Array.isArray(message.frameUrls) ? message.frameUrls : []).slice(0, 30),
        selectedEmbedUrl: typeof message.selectedEmbedUrl === 'string' ? message.selectedEmbedUrl : null };
      return writeState(state);
    }
    if (!fromPopup && sender.frameId !== 0) throw new Error('Use the download button above the video.');
    if (message.type === 'START_DOWNLOAD') return startDownload(tabId, message.sourceUrl, message.title);
    if (message.type === 'CANCEL_DOWNLOAD') {
      if (state.job?.id !== message.jobId || !busyStates.has(state.job.state)) return { ok: true, ...snapshot(state) };
      state.job.state = 'cancelled';
      state.job.message = 'Download cancelled.';
      state.job.fallback = null;
      await writeState(state);
      if (state.job.downloadId !== null) await chrome.downloads.cancel(state.job.downloadId).catch(() => {});
      await offscreen({ type: 'CANCEL', jobId: state.job.id }).catch(() => {});
      return { ok: true, ...snapshot(state) };
    }
    if (message.type === 'SHOW_DOWNLOADS' && fromPopup) {
      await chrome.tabs.create({ url: 'chrome://downloads/' });
      return { ok: true };
    }
    throw new Error('Unknown extension action.');
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || message.target === 'offscreen'
      || message.target === 'popup' || sender.id !== chrome.runtime.id) return;
  const task = sender.url === offscreenUrl ? internalMessage(message) : pageMessage(message, sender);
  task.then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.downloads.onChanged.addListener(delta => {
  if (!['complete', 'interrupted'].includes(delta.state?.current)) return;
  chrome.storage.session.get(null).then(values => {
    for (const [key, stored] of Object.entries(values)) {
      if (!key.startsWith('tab:') || stored?.job?.downloadId !== delta.id) continue;
      serial(stored.tabId, async () => {
        const state = await readState(stored.tabId);
        if (state.job?.downloadId === delta.id) {
          const items = await chrome.downloads.search({ id: delta.id });
          await finishDownload(state, delta.state.current, delta.error?.current || items[0]?.error, items[0]?.mime);
        }
      }).catch(() => {});
    }
  });
});

// Catch popups created from embedded frames outside the page-script guard.
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
  if (sourceTabId === tabId) return;
  chrome.tabs.get(sourceTabId).then(source => {
    if (supportedPage(source.url)) return chrome.tabs.remove(tabId);
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => {
  serial(tabId, async () => {
    const state = await readState(tabId);
    // Direct browser downloads continue if the page closes. HLS assembly releases its memory.
    if (state.job?.kind === 'hls' && state.job.downloadId === null) {
      await offscreen({ type: 'CANCEL', jobId: state.job.id }).catch(() => {});
    }
    if (!busyStates.has(state.job?.state) || state.job?.downloadId === null) {
      await chrome.storage.session.remove('tab:' + tabId);
    }
  }).catch(() => {});
});
