// ==UserScript==
// @name         Preax Image Pool
// @namespace    http://tampermonkey.net/
// @version      1.3.0
// @description  Two image pools for drag-and-drop paste into Lexical editor on preax.ru/review
// @author       user
// @match        https://preax.ru/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* global MutationObserver, ClipboardEvent, DataTransfer, InputEvent, ClipboardItem */

(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────────
  const pools = [[], []]; // pools[0] = "Баги", pools[1] = "Рекомендации"
  const POOL_KEYWORDS = ['баги', 'рекомендации'];

  // Index of pool in capture mode via header click (yellow border, -1 = none)
  let selectedPoolIdx = -1;
  // Index of pool waiting for next Ctrl+V via 📋 button (-1 = none)
  let clipPendingIdx = -1;
  // Parallel to pools — stores base64 data URLs for localStorage persistence
  const poolDataUrls = [[], []];
  // Tracks last seen editor element and active keyword index for auto-paste
  let lastEditorEl = null;
  let lastActiveIdx = -1;
  // Timer for delayed auto-paste (cancelled/rescheduled on each navigation)
  let autoPasteTimer = null;

  // ─── CSS ─────────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #pip-wrapper {
      position: fixed;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      align-items: center;
      z-index: 2147483647;
      transition: transform 0.3s ease;
    }

    #pip-wrapper.pip-collapsed {
      transform: translateY(-50%) translateX(calc(100% - 32px));
    }

    #pip-toggle {
      width: 32px;
      height: 64px;
      flex-shrink: 0;
      background: rgba(30, 30, 30, 0.95);
      border: 1px solid #555;
      border-right: none;
      border-radius: 8px 0 0 8px;
      color: #aaa;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: background 0.15s, color 0.15s;
    }


    #pip-toggle:hover {
      background: rgba(60, 60, 60, 0.98);
      color: #fff;
    }

    #pip-container {
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 16px;
      padding: 0 12px 0 0;
    }

    .pip-panel {
      width: 20vw;
      height: 20vh;
      min-width: 400px;
      min-height: 130px;
      background: rgba(20, 20, 20, 0.92);
      border: 2px dashed #555;
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      color: #eee;
      transition: border-color 0.15s, box-shadow 0.15s;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    }

    /* Active = h1 matches this pool's keyword AND editor is present */
    .pip-panel.pip-active {
      border-color: #4caf50;
      border-style: solid;
      box-shadow: 0 4px 20px rgba(76,175,80,0.35);
    }

    /* Editor found but h1 matches the OTHER pool's keyword */
    .pip-panel.pip-editor-found {
      border-color: #888;
      border-style: solid;
    }

    .pip-panel.pip-drag-over {
      border-color: #2196f3;
      background: rgba(33, 150, 243, 0.15);
    }

    /* Selected for Ctrl+V → add image to pool */
    .pip-panel.pip-selected {
      border-color: #ffc107;
      border-style: solid;
      box-shadow: 0 4px 20px rgba(255, 193, 7, 0.3);
    }
    .pip-panel.pip-selected .pip-title { color: #ffc107; }

    .pip-header {
      padding: 5px 8px;
      background: rgba(255,255,255,0.08);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      gap: 4px;
      cursor: pointer;
    }

    .pip-title {
      font-weight: 600;
      font-size: 15px;
      letter-spacing: 0.4px;
      color: #ccc;
      user-select: none;
    }

    .pip-count {
      font-size: 13px;
      color: #888;
      margin-left: 4px;
    }

    .pip-btn {
      border: none;
      border-radius: 5px;
      padding: 0;
      width: 32px;
      height: 32px;
      flex-shrink: 0;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      line-height: 1;
      transition: opacity 0.1s;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
    }
    .pip-btn:hover { opacity: 0.8; }
    .pip-btn:active { opacity: 0.6; }

    .pip-btn-paste {
      background: #4caf50;
      color: #fff;
      width: auto;
      padding: 0 10px;
    }
    .pip-btn-paste:disabled {
      background: #444;
      color: #777;
      cursor: not-allowed;
    }

    .pip-btn-clip {
      background: #1565c0;
      color: #fff;
    }

    .pip-btn-file {
      background: #00796b;
      color: #fff;
    }

    .pip-btn-clear {
      background: #c62828;
      color: #fff;
    }

    .pip-dropzone {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 6px;
      align-content: flex-start;
      cursor: pointer;
    }

    .pip-placeholder {
      width: 100%;
      text-align: center;
      color: #666;
      padding-top: 14px;
      pointer-events: none;
      user-select: none;
      font-size: 13px;
      line-height: 1.5;
    }

    .pip-thumb-wrap {
      position: relative;
      width: 44px;
      height: 44px;
      flex-shrink: 0;
    }

    .pip-thumb {
      width: 44px;
      height: 44px;
      object-fit: cover;
      border-radius: 5px;
      border: 1px solid #333;
      pointer-events: none;
      display: block;
    }

    .pip-thumb-del {
      position: absolute;
      top: -4px;
      right: -4px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #c62828;
      color: #fff;
      cursor: pointer;
      border: none;
      padding: 0;
      opacity: 0;
      transition: opacity 0.12s;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .pip-thumb-wrap:hover .pip-thumb-del {
      opacity: 1;
    }

    .pip-status {
      font-size: 13px;
      color: #aaa;
      padding: 2px 8px 4px;
      flex-shrink: 0;
      min-height: 16px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;
  document.head.appendChild(style);

  // ─── Icons (24×24 filled SVG paths) ──────────────────────────────────────────
  function icon(path, size) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor"><path d="${path}"/></svg>`;
  }
  const IC_CLIP  = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M14.4176 14.2277C14.4176 15.2065 13.624 16 12.6452 16H3.36609C2.38727 16 1.59375 15.2065 1.59375 14.2277V2.94178C1.59375 1.96296 2.38727 1.16944 3.36609 1.16944H5.10102V2.45933C5.10102 3.00313 5.54185 3.44396 6.08564 3.44396H9.92567C10.4695 3.44396 10.9103 3.00313 10.9103 2.45933V1.16944H12.6452C13.624 1.16944 14.4176 1.96296 14.4176 2.94178V14.2277ZM3.67325 11.7405H7.14904C7.1749 11.7405 7.2005 11.7456 7.22439 11.7555C7.24828 11.7654 7.26999 11.7799 7.28827 11.7982C7.30656 11.8164 7.32106 11.8381 7.33096 11.862C7.34085 11.8859 7.34595 11.9115 7.34595 11.9374C7.34595 11.9633 7.34085 11.9889 7.33096 12.0127C7.32106 12.0366 7.30656 12.0583 7.28827 12.0766C7.26999 12.0949 7.24828 12.1094 7.22439 12.1193C7.2005 12.1292 7.1749 12.1343 7.14904 12.1343H3.67325C3.64739 12.1343 3.62178 12.1292 3.59789 12.1193C3.574 12.1094 3.5523 12.0949 3.53401 12.0766C3.51573 12.0583 3.50122 12.0366 3.49133 12.0127C3.48143 11.9889 3.47634 11.9633 3.47634 11.9374C3.47634 11.9115 3.48143 11.8859 3.49133 11.862C3.50122 11.8381 3.51573 11.8164 3.53401 11.7982C3.5523 11.7799 3.574 11.7654 3.59789 11.7555C3.62178 11.7456 3.64739 11.7405 3.67325 11.7405ZM8.79337 11.7405H12.2691C12.3213 11.7405 12.3714 11.7612 12.4083 11.7982C12.4453 11.8351 12.466 11.8852 12.466 11.9374C12.466 11.9896 12.4453 12.0397 12.4083 12.0766C12.3714 12.1136 12.3213 12.1343 12.2691 12.1343H8.79337C8.76751 12.1343 8.74191 12.1292 8.71802 12.1193C8.69413 12.1094 8.67242 12.0949 8.65413 12.0766C8.63585 12.0583 8.62134 12.0366 8.61145 12.0127C8.60155 11.9889 8.59646 11.9633 8.59646 11.9374C8.59646 11.9115 8.60155 11.8859 8.61145 11.862C8.62134 11.8381 8.63585 11.8164 8.65413 11.7982C8.67242 11.7799 8.69413 11.7654 8.71802 11.7555C8.74191 11.7456 8.76751 11.7405 8.79337 11.7405ZM3.67325 7.21116H7.13917C7.1914 7.21116 7.24148 7.23191 7.27841 7.26884C7.31534 7.30577 7.33608 7.35585 7.33608 7.40808C7.33608 7.4603 7.31534 7.51038 7.27841 7.54731C7.24148 7.58424 7.1914 7.60499 7.13917 7.60499H3.67325C3.62102 7.60499 3.57094 7.58424 3.53401 7.54731C3.49708 7.51038 3.47634 7.4603 3.47634 7.40808C3.47634 7.35585 3.49708 7.30577 3.53401 7.26884C3.57094 7.23191 3.62102 7.21116 3.67325 7.21116ZM8.79337 7.21116H12.2592C12.3115 7.21116 12.3615 7.23191 12.3985 7.26884C12.4354 7.30577 12.4561 7.35585 12.4561 7.40808C12.4561 7.4603 12.4354 7.51038 12.3985 7.54731C12.3615 7.58424 12.3115 7.60499 12.2592 7.60499H8.79337C8.74115 7.60499 8.69106 7.58424 8.65413 7.54731C8.61721 7.51038 8.59646 7.4603 8.59646 7.40808C8.59646 7.35585 8.61721 7.30577 8.65413 7.26884C8.69106 7.23191 8.74115 7.21116 8.79337 7.21116Z" fill="currentColor"/><path d="M6.68272 1.12709C6.64678 1.15548 6.60207 1.17046 6.55627 1.16944H5.49484V2.45933C5.49484 2.61602 5.55709 2.7663 5.66788 2.87709C5.77868 2.98789 5.92895 3.05014 6.08564 3.05014H9.93553C10.0922 3.05014 10.2425 2.98789 10.3533 2.87709C10.4641 2.7663 10.5263 2.61602 10.5263 2.45933V1.16944H9.46686C9.42106 1.17046 9.37635 1.15548 9.34041 1.12709C9.30447 1.09869 9.27955 1.05865 9.26995 1.01387C9.2074 0.726632 9.04848 0.469435 8.81956 0.285002C8.59065 0.100569 8.30553 0 8.01157 0C7.7176 0 7.43248 0.100569 7.20357 0.285002C6.97465 0.469435 6.81573 0.726632 6.75318 1.01387C6.74358 1.05865 6.71866 1.09869 6.68272 1.12709Z" fill="currentColor"/></svg>`;
  const IC_TRASH = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.225 0.553125C5.39375 0.2125 5.74062 0 6.11875 0H9.88125C10.2594 0 10.6062 0.2125 10.775 0.553125L11 1H14C14.5531 1 15 1.44687 15 2C15 2.55312 14.5531 3 14 3H2C1.44687 3 1 2.55312 1 2C1 1.44687 1.44687 1 2 1H5L5.225 0.553125ZM2 4H14V14C14 15.1031 13.1031 16 12 16H4C2.89688 16 2 15.1031 2 14V4ZM5 6C4.725 6 4.5 6.225 4.5 6.5V13.5C4.5 13.775 4.725 14 5 14C5.275 14 5.5 13.775 5.5 13.5V6.5C5.5 6.225 5.275 6 5 6ZM8 6C7.725 6 7.5 6.225 7.5 6.5V13.5C7.5 13.775 7.725 14 8 14C8.275 14 8.5 13.775 8.5 13.5V6.5C8.5 6.225 8.275 6 8 6ZM11 6C10.725 6 10.5 6.225 10.5 6.5V13.5C10.5 13.775 10.725 14 11 14C11.275 14 11.5 13.775 11.5 13.5V6.5C11.5 6.225 11.275 6 11 6Z" fill="currentColor"/></svg>`;
  const IC_FILE  = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14.8781 8.30978C16.374 6.81395 16.374 4.39152 14.8781 2.89569C13.5544 1.57196 11.4682 1.39987 9.94589 2.48798L9.90353 2.51711C9.5223 2.7898 9.43493 3.31929 9.70762 3.69788C9.98031 4.07647 10.5098 4.16648 10.8884 3.89379L10.9308 3.86467C11.7806 3.2584 12.9428 3.35371 13.6788 4.09235C14.5128 4.92631 14.5128 6.27652 13.6788 7.11047L10.7084 10.0862C9.87441 10.9202 8.5242 10.9202 7.69025 10.0862C6.9516 9.34759 6.85629 8.18535 7.46256 7.33815L7.49168 7.29579C7.76437 6.91456 7.67436 6.38506 7.29577 6.11502C6.91718 5.84498 6.38504 5.93235 6.115 6.31093L6.08588 6.35329C4.99512 7.87294 5.1672 9.95915 6.49094 11.2829C7.98676 12.7787 10.4092 12.7787 11.905 11.2829L14.8781 8.30978ZM1.12187 7.69027C-0.373955 9.18609 -0.373955 11.6085 1.12187 13.1043C2.4456 14.4281 4.53181 14.6002 6.05411 13.5121L6.09647 13.4829C6.4777 13.2102 6.56507 12.6808 6.29238 12.3022C6.01969 11.9236 5.4902 11.8336 5.11161 12.1063L5.06925 12.1354C4.21941 12.7416 3.05717 12.6463 2.32117 11.9077C1.48722 11.0711 1.48722 9.72088 2.32117 8.88693L5.29164 5.91381C6.12559 5.07986 7.4758 5.07986 8.30975 5.91381C9.0484 6.65246 9.14371 7.8147 8.53744 8.66454L8.50832 8.7069C8.23563 9.08813 8.32564 9.61763 8.70423 9.88767C9.08282 10.1577 9.61496 10.0703 9.885 9.69176L9.91412 9.6494C11.0049 8.1271 10.8328 6.04089 9.50906 4.71716C8.01324 3.22133 5.5908 3.22133 4.09498 4.71716L1.12187 7.69027Z" fill="currentColor"/></svg>`;
  const IC_CLOSE = 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';
  const IC_RIGHT = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.2366 7.19313C12.6828 7.63941 12.6828 8.36416 12.2366 8.81044L5.38171 15.6653C4.93543 16.1116 4.21068 16.1116 3.7644 15.6653C3.31812 15.219 3.31812 14.4943 3.7644 14.048L9.81237 8L3.76797 1.95202C3.32169 1.50575 3.32169 0.780988 3.76797 0.334709C4.21425 -0.11157 4.939 -0.11157 5.38528 0.334709L12.2401 7.18956L12.2366 7.19313Z" fill="currentColor"/></svg>`;
  const IC_LEFT  = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="transform:rotate(180deg)"><path d="M12.2366 7.19313C12.6828 7.63941 12.6828 8.36416 12.2366 8.81044L5.38171 15.6653C4.93543 16.1116 4.21068 16.1116 3.7644 15.6653C3.31812 15.219 3.31812 14.4943 3.7644 14.048L9.81237 8L3.76797 1.95202C3.32169 1.50575 3.32169 0.780988 3.76797 0.334709C4.21425 -0.11157 4.939 -0.11157 5.38528 0.334709L12.2401 7.18956L12.2366 7.19313Z" fill="currentColor"/></svg>`;

  // ─── Build UI ─────────────────────────────────────────────────────────────────
  const wrapper = document.createElement('div');
  wrapper.id = 'pip-wrapper';

  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'pip-toggle';
  toggleBtn.innerHTML = IC_RIGHT;
  toggleBtn.title = 'Скрыть / показать панели';
  toggleBtn.addEventListener('click', toggleCollapsed);
  wrapper.appendChild(toggleBtn);

  const container = document.createElement('div');
  container.id = 'pip-container';

  const panels = [0, 1].map((idx) => buildPanel(idx));
  panels.forEach((p) => container.appendChild(p.el));
  wrapper.appendChild(container);
  document.body.appendChild(wrapper);

  // ─── URL visibility guard ─────────────────────────────────────────────────────
  function isReviewPage() {
    return window.location.href.includes('preax.ru/review');
  }

  function syncVisibility() {
    wrapper.style.display = isReviewPage() ? '' : 'none';
  }

  // Intercept SPA history mutations
  ['pushState', 'replaceState'].forEach((method) => {
    const orig = history[method];
    history[method] = function (...args) {
      const result = orig.apply(this, args);
      syncVisibility();
      return result;
    };
  });
  window.addEventListener('popstate', syncVisibility);

  syncVisibility(); // initial check

  // Restore collapsed state
  if (localStorage.getItem('pip-collapsed') === '1') {
    wrapper.classList.add('pip-collapsed');
    toggleBtn.innerHTML = IC_LEFT;
  }

  function toggleCollapsed() {
    const collapsed = wrapper.classList.toggle('pip-collapsed');
    toggleBtn.innerHTML = collapsed ? IC_LEFT : IC_RIGHT;
    localStorage.setItem('pip-collapsed', collapsed ? '1' : '0');
  }

  function buildPanel(idx) {
    const keyword = POOL_KEYWORDS[idx];
    const label = keyword.charAt(0).toUpperCase() + keyword.slice(1);

    const el = document.createElement('div');
    el.className = 'pip-panel';
    el.dataset.pool = idx;

    const header = document.createElement('div');
    header.className = 'pip-header';

    const titleWrap = document.createElement('span');
    titleWrap.style.cssText = 'display:flex;align-items:center;flex:1;min-width:0';
    titleWrap.innerHTML = `<span class="pip-title">${label}</span><span class="pip-count" id="pip-count-${idx}">0 фото</span>`;

    const btnClip = document.createElement('button');
    btnClip.className = 'pip-btn pip-btn-clip';
    btnClip.innerHTML = IC_CLIP;
    btnClip.title = 'Вставить изображение из буфера обмена в пул';
    btnClip.addEventListener('click', () => readClipboardToPool(idx));

    const btnPaste = document.createElement('button');
    btnPaste.className = 'pip-btn pip-btn-paste';
    btnPaste.innerHTML = 'Вставить';
    btnPaste.disabled = true;
    btnPaste.id = `pip-paste-${idx}`;
    btnPaste.addEventListener('click', () => pastePool(idx));

    const btnClear = document.createElement('button');
    btnClear.className = 'pip-btn pip-btn-clear';
    btnClear.innerHTML = IC_TRASH;
    btnClear.title = 'Очистить пул';
    btnClear.addEventListener('click', () => clearPool(idx));

    // Click on header area (not on a button) → toggle capture mode
    header.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      selectPool(idx);
    });

    const btnFile = document.createElement('button');
    btnFile.className = 'pip-btn pip-btn-file';
    btnFile.innerHTML = IC_FILE;
    btnFile.title = 'Добавить файл с диска';
    btnFile.addEventListener('click', () => pickFiles(idx));

    header.appendChild(titleWrap);
    header.appendChild(btnFile);
    header.appendChild(btnClip);
    header.appendChild(btnPaste);
    header.appendChild(btnClear);

    const dropzone = document.createElement('div');
    dropzone.className = 'pip-dropzone';
    dropzone.id = `pip-dropzone-${idx}`;
    dropzone.innerHTML = `<div class="pip-placeholder">Перетащите изображения<br>или кликните для захвата Ctrl+V</div>`;

    dropzone.addEventListener('click', () => selectPool(idx));
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('pip-drag-over');
    });
    dropzone.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('pip-drag-over');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('pip-drag-over');
      Array.from(e.dataTransfer.files)
        .filter((f) => f.type.startsWith('image/'))
        .forEach((f) => addToPool(idx, f));
    });

    const status = document.createElement('div');
    status.className = 'pip-status';
    status.id = `pip-status-${idx}`;

    el.appendChild(header);
    el.appendChild(dropzone);
    el.appendChild(status);

    return { el, dropzone, btnPaste, status };
  }

  // ─── File handling ────────────────────────────────────────────────────────────
  async function readClipboardToPool(idx) {
    try {
      const perm = await navigator.permissions.query({ name: 'clipboard-read' });
      if (perm.state !== 'granted') {
        clipPendingIdx = idx;
        setStatus(idx, '← нажмите Ctrl+V');
        return;
      }
    } catch {
      // Permissions API unavailable — try reading directly
    }

    try {
      const items = await navigator.clipboard.read();
      let added = 0;
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            const ext = type.split('/')[1] || 'png';
            const file = new File([blob], `clip-${Date.now()}-${added}.${ext}`, { type });
            addToPool(idx, file);
            added++;
          }
        }
      }
      if (added === 0) {
        setStatus(idx, '⚠ В буфере нет изображения');
      } else {
        navigator.clipboard.writeText('').catch(() => {});
      }
    } catch {
      clipPendingIdx = idx;
      setStatus(idx, '← нажмите Ctrl+V');
    }
  }

  function pickFiles(idx) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = () => Array.from(input.files).forEach((f) => addToPool(idx, f));
    input.click();
  }

  // ─── localStorage persistence ─────────────────────────────────────────────────
  function savePool(idx) {
    try {
      const data = poolDataUrls[idx].map((dataUrl, i) => ({
        dataUrl,
        name: pools[idx][i]?.name || `image-${i}.png`,
        type: pools[idx][i]?.type || 'image/png',
      }));
      localStorage.setItem(`pip-pool-${idx}`, JSON.stringify(data));
    } catch {
      setStatus(idx, '⚠ localStorage переполнен');
    }
  }

  function dataUrlToFile(dataUrl, name, type) {
    const [, base64] = dataUrl.split(',');
    const binary = atob(base64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return new File([arr], name, { type });
  }

  function loadAllPools() {
    [0, 1].forEach((idx) => {
      try {
        const stored = localStorage.getItem(`pip-pool-${idx}`);
        if (!stored) return;
        const items = JSON.parse(stored);
        items.forEach(({ dataUrl, name, type }) => {
          addToPool(idx, dataUrlToFile(dataUrl, name, type), dataUrl);
        });
      } catch {
        localStorage.removeItem(`pip-pool-${idx}`);
      }
    });
  }

  // ─── File handling ─────────────────────────────────────────────────────────────
  function addToPool(idx, file, existingDataUrl = null) {
    pools[idx].push(file);

    const dropzone = document.getElementById(`pip-dropzone-${idx}`);
    const placeholder = dropzone.querySelector('.pip-placeholder');
    if (placeholder) placeholder.remove();

    const wrap = document.createElement('div');
    wrap.className = 'pip-thumb-wrap';

    const del = document.createElement('button');
    del.className = 'pip-thumb-del';
    del.innerHTML = icon(IC_CLOSE, 9);
    del.title = 'Удалить';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromPool(idx, wrap);
    });

    const renderThumb = (dataUrl) => {
      poolDataUrls[idx].push(dataUrl);
      savePool(idx);
      const img = document.createElement('img');
      img.className = 'pip-thumb';
      img.src = dataUrl;
      wrap.appendChild(img);
      wrap.appendChild(del);
      dropzone.appendChild(wrap);
    };

    if (existingDataUrl) {
      renderThumb(existingDataUrl);
    } else {
      const reader = new FileReader();
      reader.onload = (e) => renderThumb(e.target.result);
      reader.readAsDataURL(file);
    }

    updateCount(idx);
  }

  function removeFromPool(idx, wrapEl) {
    const dropzone = document.getElementById(`pip-dropzone-${idx}`);
    const wraps = Array.from(dropzone.querySelectorAll('.pip-thumb-wrap'));
    const pos = wraps.indexOf(wrapEl);
    if (pos !== -1) {
      pools[idx].splice(pos, 1);
      poolDataUrls[idx].splice(pos, 1);
    }
    wrapEl.remove();
    if (pools[idx].length === 0) {
      dropzone.innerHTML = `<div class="pip-placeholder">Перетащите изображения<br>или нажмите для выбора</div>`;
    }
    updateCount(idx);
    savePool(idx);
  }

  function clearPool(idx) {
    pools[idx] = [];
    poolDataUrls[idx] = [];
    localStorage.removeItem(`pip-pool-${idx}`);
    const dropzone = document.getElementById(`pip-dropzone-${idx}`);
    dropzone.innerHTML = `<div class="pip-placeholder">Перетащите изображения<br>или нажмите для выбора</div>`;
    updateCount(idx);
    setStatus(idx, '');
  }

  function updateCount(idx) {
    const n = pools[idx].length;
    document.getElementById(`pip-count-${idx}`).textContent = `${n} фото`;
    document.getElementById(`pip-paste-${idx}`).disabled = n === 0;
  }

  function setStatus(idx, text) {
    document.getElementById(`pip-status-${idx}`).textContent = text;
  }

  // ─── H1 + Editor detection ────────────────────────────────────────────────────
  const EDITOR_SELECTOR = 'div[data-lexical-editor="true"][contenteditable="true"]';

  function getEditor() {
    return document.querySelector(EDITOR_SELECTOR);
  }

  function getActivePoolIndex() {
    // Check ALL h1 elements — the page may have navigation h1s before the step header
    for (const h1 of document.querySelectorAll('h1')) {
      const text = h1.textContent.toLowerCase();
      const idx = POOL_KEYWORDS.findIndex((kw) => text.includes(kw));
      if (idx !== -1) return idx;
    }
    return -1;
  }

  function updatePanelStates() {
    const editor = getEditor();
    const activeIdx = getActivePoolIndex();

    // Update borders:
    //   pip-active       → this pool's keyword matches h1 (green)
    //   pip-editor-found → editor present, other pool matches (grey)
    //   (no class)       → "Плюсы работы" or no editor (default dashed)
    panels.forEach(({ el }, idx) => {
      el.classList.remove('pip-active', 'pip-editor-found');
      if (editor && activeIdx !== -1) {
        el.classList.add(idx === activeIdx ? 'pip-active' : 'pip-editor-found');
      }
    });

    // Auto-paste triggers when:
    //   • h1 keyword changes (stepChanged): navigated to Баги/Рекомендации from another step
    //   • editor DOM element is replaced (editorReplaced): SPA recreated the editor on same step
    const stepChanged = editor !== null && activeIdx !== -1 && activeIdx !== lastActiveIdx;
    const editorReplaced = editor !== null && activeIdx !== -1 && editor !== lastEditorEl;

    if (stepChanged || editorReplaced) {
      lastEditorEl = editor;
      lastActiveIdx = activeIdx;
      if (pools[activeIdx].length > 0) {
        scheduleAutoPaste(activeIdx);
      }
    }

    // Reset tracking whenever we leave an active keyword page.
    // This ensures auto-paste fires again when the user returns to Баги/Рекомендации.
    if (!editor || activeIdx === -1) {
      lastEditorEl = null;
      lastActiveIdx = -1;
    }
  }

  // Откладывает автовставку на 2.5 с после обнаружения редактора.
  // Если за это время страница сменится — вставка отменяется.
  // При повторном срабатывании таймер сбрасывается и отсчёт начинается заново.
  function scheduleAutoPaste(activeIdx) {
    if (autoPasteTimer !== null) clearTimeout(autoPasteTimer);
    setStatus(activeIdx, '⏳ Вставка через 1 с…');
    autoPasteTimer = setTimeout(async () => {
      autoPasteTimer = null;
      const currentEditor = getEditor();
      const currentIdx = getActivePoolIndex();
      // Проверяем, что страница не изменилась за время ожидания
      if (currentEditor === null || currentIdx !== activeIdx) {
        setStatus(activeIdx, '');
        return;
      }
      if (pools[activeIdx].length === 0) return;
      await pastePool(activeIdx);
    }, 1000);
  }

  // MutationObserver: watch for structural changes (editor appearing/disappearing).
  // No characterData — Lexical fires thousands of text-node mutations while editing.
  let rafScheduled = false;
  function scheduleUpdate() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      updatePanelStates();
    });
  }

  const observer = new MutationObserver(scheduleUpdate);
  observer.observe(document.body, { childList: true, subtree: true });

  // Poll every 400 ms to catch h1 text changes driven by React state
  // (React updates text nodes in-place — no structural mutation is fired).
  setInterval(updatePanelStates, 400);
  updatePanelStates();
  loadAllPools();

  // ─── Pool selection + Ctrl+V → add to pool ───────────────────────────────────
  function selectPool(idx) {
    if (selectedPoolIdx === idx) {
      deselectPool();
      return;
    }
    selectedPoolIdx = idx;
    panels.forEach(({ el }, i) => el.classList.toggle('pip-selected', i === idx));
  }

  function deselectPool() {
    selectedPoolIdx = -1;
    panels.forEach(({ el }) => el.classList.remove('pip-selected'));
  }

  // Click outside panels → exit capture mode
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) deselectPool();
  }, true);

  // Ctrl+V → add image to pool (header capture mode OR 📋 button pending)
  document.addEventListener('paste', (e) => {
    const targetIdx = selectedPoolIdx !== -1 ? selectedPoolIdx : clipPendingIdx;
    if (targetIdx === -1) return;
    // Don't intercept when a page input/editor has focus
    const active = document.activeElement;
    if (
      active &&
      !container.contains(active) &&
      (active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    let added = 0;
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) { addToPool(targetIdx, file); added++; }
      }
    }
    clipPendingIdx = -1;
    if (added === 0) {
      setStatus(targetIdx, '⚠ В буфере нет изображения');
    } else {
      setStatus(targetIdx, '');
      navigator.clipboard.writeText('').catch(() => {});
    }
  }, true);

  // ─── Paste pool into editor ───────────────────────────────────────────────────
  async function pastePool(idx) {
    const editor = getEditor();
    if (!editor) { setStatus(idx, '⚠ Поле ввода не найдено'); return; }

    const files = pools[idx];
    if (files.length === 0) { setStatus(idx, '⚠ Пул пуст'); return; }

    for (let i = 0; i < files.length; i++) {
      setStatus(idx, `Вставка ${i + 1} / ${files.length}…`);
      const ok = await pasteFile(idx, files[i]);
      if (!ok) { setStatus(idx, `⚠ Ошибка на фото ${i + 1}`); return; }
      await delay(800);
    }

    setStatus(idx, `✓ Вставлено ${files.length} фото`);
  }

  async function pasteFile(idx, file) {
    const editor = getEditor();
    if (!editor) return false;

    // Strategy 1: write to real clipboard → execCommand('paste')
    let clipOk = false;
    const writePromise = navigator.clipboard
      .write([new ClipboardItem({ [file.type]: file })])
      .then(() => { clipOk = true; })
      .catch(() => {});

    editor.click();
    editor.focus();
    await delay(120);
    await writePromise;

    if (clipOk) {
      const pasted = document.execCommand('paste'); // deprecated but still works in Chromium
      if (pasted) return true;
    }

    // Strategy 2: synthetic ClipboardEvent with DataTransfer
    const dt = new DataTransfer();
    dt.items.add(file);
    if (dt.items.length === 0) { setStatus(idx, '⚠ DataTransfer не поддерживается'); return false; }

    editor.click();
    editor.focus();
    await delay(50);
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));

    // Strategy 3: beforeinput insertFromPaste — triggers Lexical's clipboard read
    if (clipOk) {
      await delay(50);
      editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromPaste' }));
    }

    return true;
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
})();
