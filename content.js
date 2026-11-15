(function () {
  'use strict';
  if (!globalThis.VideoDiscovery || globalThis.__streamliftActive) return;
  globalThis.__streamliftActive = true;

  const isTopFrame = window.top === window;
  const busyStates = new Set(['starting', 'downloading', 'saving']);
  const inputEvents = ['click', 'dblclick', 'auxclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown', 'keyup', 'contextmenu'];
  let host = null;
  let spacer = null;
  let ui = null;
  let anchorPoint = null;
  let resizeObserver = null;
  let lastDiscovery = '';
  let scheduled = false;
  let positionScheduled = false;
  let snapshot = { sources: [], job: null };
  let currentTitle = 'video';
  let disconnected = false;

  async function send(message) {
    if (disconnected) return null;
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (/Extension context invalidated/i.test(error.message || '')) {
        disconnected = true;
        if (ui) {
          ui.status.textContent = 'StreamLift updated. Reload this page to continue.';
          ui.download.disabled = true;
        }
      }
      return null;
    }
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function mountingPoint(anchor) {
    if (!anchor || !anchor.parentElement) return null;
    const ratioContainer = anchor.closest('[class*="aspect-"], [style*="aspect-ratio"]');
    if (ratioContainer && ratioContainer !== document.body) return ratioContainer;
    if (getComputedStyle(anchor).position === 'absolute' && anchor.parentElement !== document.body) return anchor.parentElement;
    return anchor;
  }

  function isOpen() {
    return typeof host.matches === 'function' && host.matches(':popover-open');
  }

  function placeBar() {
    positionScheduled = false;
    if (!host?.isConnected || !spacer?.isConnected || !anchorPoint?.isConnected) return;
    const bounds = spacer.getBoundingClientRect();
    const playerBounds = anchorPoint.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const width = Math.max(0, Math.min(playerBounds.width, viewportWidth - 16));
    const left = Math.min(Math.max(8, playerBounds.left), Math.max(8, viewportWidth - width - 8));
    const position = { width: width + 'px', left: left + 'px', top: bounds.top + 'px', visibility: width ? 'visible' : 'hidden' };
    for (const [property, value] of Object.entries(position)) {
      if (host.style[property] !== value) host.style.setProperty(property, value, 'important');
    }
    if (typeof host.showPopover === 'function' && !isOpen()) {
      try { host.showPopover(); } catch { /* A removed anchor will be rediscovered. */ }
    }
    const height = Math.ceil(host.getBoundingClientRect().height);
    if (height && spacer.style.height !== height + 14 + 'px') spacer.style.height = height + 14 + 'px';
  }

  function schedulePosition() {
    if (positionScheduled || !isTopFrame) return;
    positionScheduled = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(placeBar);
    else setTimeout(placeBar, 0);
  }

  function createBar(anchor) {
    const point = mountingPoint(anchor);
    if (!point || !document.body) return;
    anchorPoint = point;
    if (host?.isConnected) {
      if (spacer.nextElementSibling !== point) point.before(spacer);
      schedulePosition();
      return;
    }
    spacer?.remove();
    spacer = element('div');
    spacer.dataset.streamliftSpacer = 'true';
    spacer.setAttribute('aria-hidden', 'true');
    spacer.style.cssText = 'display:block!important;width:100%!important;min-width:0!important;height:164px;pointer-events:none!important;';
    point.before(spacer);

    host = element('div');
    host.dataset.streamliftUi = 'true';
    host.dataset.videoDownloader = 'true';
    host.setAttribute('popover', 'manual');
    host.style.cssText = 'position:fixed!important;right:auto!important;bottom:auto!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;max-width:none!important;max-height:none!important;overflow:visible!important;box-sizing:border-box!important;pointer-events:auto!important;z-index:2147483647!important;';
    inputEvents.forEach(type => host.addEventListener(type, event => event.stopPropagation()));
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = element('style');
    style.textContent = `
      :host{font-family:Inter,system-ui,sans-serif;color:#f8fafc;color-scheme:dark}
      *{box-sizing:border-box}
      .bar{container-type:inline-size;background:linear-gradient(125deg,#0b1b31,#101b2e);border:1px solid #285073;border-radius:16px;padding:16px;box-shadow:0 12px 32px #020b1d35}
      .heading{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:13px;font-weight:750;color:#dbeafe;letter-spacing:.2px}
      .mark{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;background:#0c6be5;color:#fff;font-size:19px;line-height:1}
      .controls{display:grid;grid-template-columns:minmax(220px,1.8fr) minmax(160px,1fr);gap:14px;align-items:end}
      button,select{font:inherit}
      .download{width:100%;min-height:74px;display:flex;align-items:center;justify-content:center;gap:12px;background:linear-gradient(115deg,#1674f2,#0c9bd4);border:1px solid #63bfff;border-radius:12px;color:white;font-size:22px;font-weight:750;letter-spacing:.1px;padding:14px 24px;cursor:pointer;box-shadow:0 5px 18px #0878ca30}
      .download:hover{background:linear-gradient(115deg,#2887ff,#14afe7)}
      button:focus-visible,select:focus-visible{outline:3px solid #a5e3ff;outline-offset:3px}
      button:disabled,select:disabled{opacity:.65;cursor:default}
      .arrow{font-size:32px;line-height:1;font-weight:500}
      label{display:block;color:#afc3dd;font-size:12px;font-weight:650;margin:0 0 7px}
      select{display:block;width:100%;min-width:0;height:44px;border:1px solid #3c5777;border-radius:9px;background:#12243b;color:#f8fafc;padding:0 12px;font-size:13px;cursor:pointer;text-overflow:ellipsis}
      .footer{display:flex;align-items:center;gap:12px;margin-top:12px;min-width:0}
      .status{font-size:12px;line-height:1.5;color:#aabed8;overflow-wrap:anywhere;flex:1;min-width:0}
      .status.error{color:#ffb7b7}
      .cancel{border:1px solid #456180;color:#dbeafe;border-radius:8px;background:transparent;min-height:34px;padding:6px 12px;font-size:12px;cursor:pointer}
      .cancel:hover{background:#213c58}
      progress{display:block;width:100%;height:6px;appearance:none;border:0;border-radius:4px;overflow:hidden;margin-top:12px;background:#223a54;accent-color:#57d2fa}
      progress::-webkit-progress-bar{background:#223a54;border-radius:4px}
      progress::-webkit-progress-value{background:#57d2fa;border-radius:4px}
      [hidden]{display:none!important}
      @container (max-width:560px){.controls{grid-template-columns:minmax(0,1fr)}.download{min-height:76px;font-size:21px}.footer{align-items:flex-start}.heading{margin-bottom:11px}}
    `;
    const bar = element('section', '', 'bar');
    bar.setAttribute('aria-label', 'StreamLift video download');
    const heading = element('div', '', 'heading');
    const mark = element('span', '↓', 'mark');
    mark.setAttribute('aria-hidden', 'true');
    heading.append(mark, element('span', 'StreamLift'));
    const controls = element('div', '', 'controls');
    const download = element('button', '', 'download');
    download.type = 'button';
    const arrow = element('span', '↓', 'arrow');
    arrow.setAttribute('aria-hidden', 'true');
    const downloadText = element('span', 'Download video');
    download.append(arrow, downloadText);
    const choice = element('div');
    const label = element('label', 'Video source');
    label.htmlFor = 'streamlift-source';
    const select = element('select');
    select.id = 'streamlift-source';
    choice.append(label, select);
    controls.append(download, choice);
    const footer = element('div', '', 'footer');
    const status = element('div', 'Finding video sources…', 'status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const cancel = element('button', 'Cancel', 'cancel');
    cancel.type = 'button';
    cancel.hidden = true;
    const progress = element('progress');
    progress.max = 100;
    progress.hidden = true;
    progress.setAttribute('aria-label', 'Download progress');
    footer.append(status, cancel);
    bar.append(heading, controls, footer, progress);
    shadow.append(style, bar);
    document.body.append(host);
    ui = { select, download, downloadText, status, cancel, progress };

    download.addEventListener('click', async () => {
      const sourceUrl = ui.select.value || 'auto';
      ui.download.disabled = true;
      ui.status.textContent = 'Starting download…';
      ui.status.classList.remove('error');
      const response = await send({ type: 'START_DOWNLOAD', sourceUrl, title: currentTitle });
      if (response?.error || response?.ok === false || !response) {
        snapshot.job = { state: 'error', message: response?.error || 'Unable to start the download. Reload this page and try again.' };
      }
      if (response?.job || response?.sources) updateState(response);
      else render();
    });
    cancel.addEventListener('click', async () => {
      if (!snapshot.job?.id) return;
      ui.cancel.disabled = true;
      const response = await send({ type: 'CANCEL_DOWNLOAD', jobId: snapshot.job.id });
      if (response?.error) {
        ui.status.textContent = response.error;
        ui.cancel.disabled = false;
      }
      if (response?.job || response?.sources) updateState(response);
    });
    if (typeof ResizeObserver === 'function') {
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(schedulePosition);
      resizeObserver.observe(bar);
      resizeObserver.observe(spacer);
    }
    render();
    placeBar();
  }

  function removeBar() {
    host?.remove();
    spacer?.remove();
    host = null;
    spacer = null;
    ui = null;
    anchorPoint = null;
    resizeObserver?.disconnect();
  }

  function render() {
    if (!ui) return;
    const previous = ui.select.value || 'auto';
    const choices = [{ url: 'auto', label: 'Automatic · MP4 first' }, ...(snapshot.sources || [])];
    const signature = choices.map(source => source.url + '|' + source.label + '|' + source.kind).join('\n');
    if (ui.select.dataset.signature !== signature) {
      ui.select.replaceChildren(...choices.map(source => {
        const label = source.url === 'auto' ? source.label : source.label + ' · ' + source.kind.toUpperCase();
        const option = element('option', label);
        option.value = source.url;
        return option;
      }));
      ui.select.dataset.signature = signature;
      ui.select.value = choices.some(source => source.url === previous) ? previous : 'auto';
    }
    const job = snapshot.job;
    const busy = Boolean(job && busyStates.has(job.state));
    const available = Boolean(snapshot.sources?.length);
    ui.download.disabled = disconnected || busy || !available;
    ui.select.disabled = busy || !available;
    ui.cancel.hidden = !busy;
    ui.cancel.disabled = false;
    ui.downloadText.textContent = busy ? 'Downloading…' : 'Download video';
    ui.progress.hidden = !busy;
    if (Number.isFinite(job?.progress)) ui.progress.value = Math.min(100, Math.max(0, job.progress));
    else ui.progress.removeAttribute('value');
    ui.status.classList.toggle('error', job?.state === 'error');
    if (job?.state === 'needs_permission') ui.status.textContent = 'Open StreamLift from the extension toolbar to allow this video host, then retry.';
    else if (job?.message) ui.status.textContent = job.message;
    else ui.status.textContent = available ? 'MP4 preferred. Highest available quality for HLS.' : 'Start the video to detect its source.';
    schedulePosition();
  }

  function updateState(next) {
    if (Array.isArray(next.sources)) snapshot.sources = next.sources;
    if (Object.prototype.hasOwnProperty.call(next, 'job')) snapshot.job = next.job;
    render();
  }

  async function discover() {
    scheduled = false;
    if (disconnected) return;
    const found = VideoDiscovery.discover(document, location);
    currentTitle = found.title;
    if (isTopFrame) {
      const anchor = found.anchor || document.querySelector('#player');
      if (anchor) createBar(anchor);
      else removeBar();
    }
    const payload = { type: 'DISCOVERED', pageUrl: location.href, title: found.title,
      sources: found.sources, frameUrls: found.frameUrls, selectedEmbedUrl: found.selectedEmbedUrl };
    const signature = JSON.stringify(payload);
    if (signature !== lastDiscovery) {
      lastDiscovery = signature;
      await send(payload);
      if (isTopFrame) {
        const response = await send({ type: 'GET_STATE' });
        if (response) updateState(response);
      }
    }
  }

  function schedule() {
    if (scheduled || disconnected) return;
    scheduled = true;
    setTimeout(discover, 150);
  }

  chrome.runtime.onMessage.addListener(message => {
    if (isTopFrame && message?.type === 'STATE_UPDATE') updateState(message);
  });
  const observer = new MutationObserver(records => {
    if (records.every(record => record.target === host || record.target === spacer || host?.contains(record.target))) return;
    schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'type'] });
  document.addEventListener('loadedmetadata', schedule, true);
  document.addEventListener('loadstart', schedule, true);
  document.addEventListener('scroll', schedulePosition, true);
  document.addEventListener('toggle', event => {
    if (!host?.isConnected || event.target === host || event.newState !== 'open'
      || !event.target?.matches?.(':popover-open')) return;
    if (typeof host.hidePopover === 'function' && isOpen()) {
      host.hidePopover();
      try { host.showPopover(); } catch { schedulePosition(); }
    }
  }, true);
  window.addEventListener('resize', schedulePosition);
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
  window.addEventListener('pageshow', schedule);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', schedulePosition);
    window.visualViewport.addEventListener('scroll', schedulePosition);
  }
  discover();
})();
