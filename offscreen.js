import { downloadHls } from './hls.js';
import { publicUrl } from './common.js';

const jobs = new Map();
const blobs = new Map();
const backgroundUrl = chrome.runtime.getURL('background.js');

function notify(message) {
  return chrome.runtime.sendMessage(message);
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function fetchResource(jobId, input, { signal, headers = {} }) {
  const address = publicUrl(String(input));
  const access = await notify({ type: 'FETCH_ACCESS', jobId, url: address });
  if (!access?.allowed) {
    const error = new Error(access?.error || 'This video host needs permission.');
    error.missingOrigin = access?.origin;
    throw error;
  }
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(60_000);
      // Chrome 116 supports AbortSignal.timeout. Use a controller for combined cancellation.
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      const expire = () => controller.abort(new DOMException('The video server timed out.', 'TimeoutError'));
      signal.addEventListener('abort', abort, { once: true });
      timeout.addEventListener('abort', expire, { once: true });
      try {
        response = await fetch(address, { headers, signal: controller.signal,
          credentials: 'omit', redirect: 'follow', cache: 'no-store' });
        if (response.url && new URL(response.url).origin !== new URL(address).origin) {
          // Extension host permissions apply to redirects too. Verify before consuming bytes.
          const redirected = publicUrl(response.url);
          const redirectAccess = await notify({ type: 'FETCH_ACCESS', jobId, url: redirected });
          if (!redirectAccess?.allowed) {
            await response.body?.cancel();
            const error = new Error('The redirected video host needs permission.');
            error.missingOrigin = redirectAccess?.origin;
            throw error;
          }
        }
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel();
          throw new Error('The video server returned HTTP ' + response.status + '.');
        }
        if (![200, 206].includes(response.status)) {
          await response.body?.cancel();
          throw Object.assign(new Error('The video server returned HTTP ' + response.status + '.'), { permanent: true });
        }
        // Read the body while the timeout is active, so stalled transfers are retryable.
        const bytes = await response.arrayBuffer();
        const copy = new Response(bytes, { status: response.status, headers: response.headers });
        Object.defineProperty(copy, 'url', { value: response.url || address });
        return copy;
      } finally {
        signal.removeEventListener('abort', abort);
        timeout.removeEventListener('abort', expire);
      }
    } catch (error) {
      if (signal.aborted || error.missingOrigin || error.permanent || attempt === 2) throw error;
      await delay(700 * (attempt + 1), signal);
    }
  }
}

async function run(message) {
  const controller = new AbortController();
  jobs.set(message.jobId, controller);
  const parts = [];
  try {
    const result = await downloadHls(message.url, {
      signal: controller.signal,
      fetcher: (url, options) => fetchResource(message.jobId, url, options),
      onChunk: bytes => { parts.push(new Blob([bytes])); },
      onProgress: async progress => {
        const quality = progress.resolution ? progress.resolution + ' · ' : '';
        const text = progress.phase === 'playlist' ? 'Reading the video playlist…'
          : quality + progress.completed + '/' + progress.total + ' segments · '
            + (progress.bytes / 1048576).toFixed(1) + ' MB';
        const reply = await notify({ type: 'HLS_PROGRESS', jobId: message.jobId, message: text,
          progress: progress.total ? Math.floor(progress.completed / progress.total * 98) : null });
        if (reply?.error) throw new Error(reply.error);
      },
    });
    controller.signal.throwIfAborted();
    const blob = new Blob(parts, { type: result.mimeType });
    const url = URL.createObjectURL(blob);
    blobs.set(message.jobId, url);
    const reply = await notify({ type: 'HLS_READY', jobId: message.jobId,
      url, extension: result.extension, bytes: result.bytes });
    if (reply?.error) release(message.jobId);
  } catch (error) {
    release(message.jobId);
    if (!controller.signal.aborted) {
      await notify({ type: 'HLS_ERROR', jobId: message.jobId, error: error.message,
        ...(error.missingOrigin ? { origin: error.missingOrigin } : {}) }).catch(() => {});
    }
  } finally {
    parts.length = 0;
    jobs.delete(message.jobId);
  }
}

function release(jobId) {
  const url = blobs.get(jobId);
  if (url) URL.revokeObjectURL(url);
  blobs.delete(jobId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab
      || (sender.url && sender.url !== backgroundUrl)) return;
  if (message.type === 'RUN_HLS') {
    if (jobs.has(message.jobId) || blobs.has(message.jobId)) {
      sendResponse({ accepted: false, error: 'This download is already running.' });
      return;
    }
    sendResponse({ accepted: true });
    run(message);
  } else if (message.type === 'CANCEL') {
    jobs.get(message.jobId)?.abort(new DOMException('Download cancelled.', 'AbortError'));
    release(message.jobId);
    sendResponse({ ok: true });
  } else if (message.type === 'RELEASE') {
    release(message.jobId);
    sendResponse({ ok: true });
  }
});
