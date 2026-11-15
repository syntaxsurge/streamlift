(function () {
  'use strict';

  const hostname = location.hostname.toLowerCase();
  const supported = hostname === 'garpf.com' || hostname === 'pinaytg.com'
    || hostname.endsWith('.pinaytg.com') || hostname === 'lootedpinay.com'
    || hostname.endsWith('.lootedpinay.com');
  if (!supported || window.__streamliftPopupGuard) return;
  Object.defineProperty(window, '__streamliftPopupGuard', { value: true });

  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  const listeners = new WeakMap();
  const protectedEvents = new Set(['click', 'dblclick', 'auxclick', 'contextmenu',
    'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend',
    'keydown', 'keyup']);
  const protectedSelector = '[data-streamlift-ui]';
  const adSelectors = '#dontfoid,[data-ad-overlay],[data-popunder],.ad-overlay,.popunder-overlay,'
    + 'iframe[src^="https://namebrain.org/"],iframe[src^="http://namebrain.org/"],iframe[src^="//namebrain.org/"]';
  const playerContainers = '#player,.video-player,.plyr,.jwplayer,.mejs-container,.fluid_video_wrapper';
  const protectedOverlays = protectedSelector + ',[data-streamlift-spacer],dialog,[role="dialog"],'
    + '[role="alertdialog"],[aria-modal="true"],.fluid_video_playback_rates,.fluid_context_menu,.fluid_controls_container';

  function fromExtensionUi(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    return path.some(node => node?.nodeType === 1 && node.matches(protectedSelector));
  }

  function captureOption(options) {
    return options === true || Boolean(options && typeof options === 'object' && options.capture);
  }

  // Page-world callbacks skip extension controls. Isolated-world control handlers
  // retain their normal event delivery, including keyboard activation.
  function guardedAdd(type, listener, options) {
    if (!listener || !protectedEvents.has(type)) {
      return nativeAdd.call(this, type, listener, options);
    }
    let byListener = listeners.get(this);
    if (!byListener) { byListener = new WeakMap(); listeners.set(this, byListener); }
    let byType = byListener.get(listener);
    if (!byType) { byType = new Map(); byListener.set(listener, byType); }
    const key = type + ':' + captureOption(options);
    let wrapped = byType.get(key);
    if (!wrapped) {
      wrapped = function (event) {
        if (fromExtensionUi(event)) return;
        if (typeof listener === 'function') listener.call(this, event);
        else if (typeof listener.handleEvent === 'function') listener.handleEvent(event);
      };
      byType.set(key, wrapped);
    }
    return nativeAdd.call(this, type, wrapped, options);
  }

  function guardedRemove(type, listener, options) {
    const key = type + ':' + captureOption(options);
    const wrapped = listener && listeners.get(this)?.get(listener)?.get(key);
    return nativeRemove.call(this, type, wrapped || listener, options);
  }

  Object.defineProperty(EventTarget.prototype, 'addEventListener', {
    value: guardedAdd, writable: false, configurable: false,
  });
  Object.defineProperty(EventTarget.prototype, 'removeEventListener', {
    value: guardedRemove, writable: false, configurable: false,
  });

  Object.defineProperty(window, 'open', {
    value: function () { return null; }, writable: false, configurable: false,
  });

  function opensAnotherContext(element, submitter) {
    const ownTarget = submitter?.getAttribute('formtarget') ?? element.getAttribute('target');
    const inheritedTarget = document.querySelector('base[target]')?.getAttribute('target');
    const target = (ownTarget === null ? inheritedTarget || '' : ownTarget).trim().toLowerCase();
    return Boolean(target) && !['_self', '_top', '_parent'].includes(target);
  }

  function stopNewContext(event) {
    if (fromExtensionUi(event)) return;
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    const link = target?.closest('a[href],area[href]');
    if (!link) return;
    if (opensAnotherContext(link) || event.type === 'auxclick' && event.button === 1
        || event.type === 'click' && (event.ctrlKey || event.metaKey || event.shiftKey)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  nativeAdd.call(window, 'click', stopNewContext, true);
  nativeAdd.call(window, 'auxclick', stopNewContext, true);
  nativeAdd.call(window, 'submit', event => {
    if (event.target && opensAnotherContext(event.target, event.submitter)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  // Detached links can navigate without their synthetic click reaching window.
  for (const prototype of [HTMLAnchorElement.prototype, HTMLAreaElement.prototype]) {
    const click = prototype.click;
    Object.defineProperty(prototype, 'click', {
      value: function (...args) {
        if (opensAnotherContext(this)) return;
        return Reflect.apply(click, this, args);
      }, writable: false, configurable: false,
    });
  }

  for (const method of ['submit', 'requestSubmit']) {
    const original = HTMLFormElement.prototype[method];
    if (typeof original !== 'function') continue;
    Object.defineProperty(HTMLFormElement.prototype, method, {
      value: function (...args) {
        if (opensAnotherContext(this, method === 'requestSubmit' ? args[0] : null)) return;
        return Reflect.apply(original, this, args);
      }, writable: false, configurable: false,
    });
  }

  function dismiss(element) {
    if (!element || element.dataset.streamliftDismissed
        || element.closest(protectedOverlays)) return;
    if (element.matches('html,body,video,audio,' + playerContainers)
        || element.querySelector('video,audio')) return;
    element.dataset.streamliftDismissed = 'true';
    element.style.setProperty('display', 'none', 'important');
    element.style.setProperty('pointer-events', 'none', 'important');
  }

  function transparentCover(element) {
    if (!element || element.dataset.streamliftDismissed
        || element.closest(protectedOverlays)
        || element.matches('html,body,' + playerContainers)
        || element.matches('[class*="fluid_video_"],[class*="fluid_control"],[class*="fluid_buffer"]')
        || element.querySelector('video,audio,iframe,img,svg,canvas,button,input,select,textarea,dialog,[role="dialog"]')
        || element.textContent.trim()) return false;
    const style = getComputedStyle(element);
    const player = element.closest(playerContainers);
    // LootedPinay adds an empty, maximum-z-index click catcher inside its player frame.
    const maximumLayerCatcher = Number.parseInt(style.zIndex, 10) >= 2147480000
      && element.matches('div:not([role]):not([aria-label]):not([tabindex])')
      && element.childElementCount === 0;
    if ((player && !maximumLayerCatcher)
        || (style.position !== 'fixed' && !(maximumLayerCatcher && style.position === 'absolute'))
        || style.pointerEvents === 'none'
        || style.display === 'none' || style.visibility === 'hidden') return false;
    const bounds = element.getBoundingClientRect();
    const playerBounds = player?.getBoundingClientRect();
    const width = playerBounds?.width || innerWidth;
    const height = playerBounds?.height || innerHeight;
    if (width <= 0 || height <= 0 || bounds.width < width * 0.85 || bounds.height < height * 0.85) return false;
    const background = style.backgroundColor.replace(/\s+/g, '');
    const transparent = background === 'transparent' || /^rgba\([^)]*,0(?:\.0+)?\)$/.test(background);
    return transparent && (!style.backgroundImage || style.backgroundImage === 'none');
  }

  function scan() {
    scheduled = false;
    for (const element of document.querySelectorAll(adSelectors)) dismiss(element);
    const points = [[innerWidth / 2, innerHeight / 2], [2, 2],
      [Math.max(2, innerWidth - 3), Math.max(2, innerHeight - 3)]];
    const candidates = new Set(document.querySelectorAll('[style*="2147483"]'));
    for (const [x, y] of points) {
      for (const element of document.elementsFromPoint(x, y).slice(0, 12)) candidates.add(element);
    }
    for (const element of candidates) if (transparentCover(element)) dismiss(element);
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(scan, 40);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'style', 'id', 'src', 'data-ad-overlay', 'data-popunder'] });
  nativeAdd.call(window, 'resize', schedule);
  nativeAdd.call(window, 'scroll', schedule, true);
  nativeAdd.call(document, 'DOMContentLoaded', schedule, { once: true });
  schedule();
})();
