/*
  Perplexity-like Chat (Sonar API) — client-side app
  - Stores API key and UI settings in localStorage.
  - Streams responses via fetch() + manual SSE parsing.
  - Shows citations + search results in the UI.

  Notes:
  - Large attachments (base64) are kept in memory for the current session.
    Persisting them in localStorage is avoided to prevent quota issues.
*/

(() => {
  const LS = {
    apiKey: 'pplx_api_key',
    settings: 'pplx_settings',
    threads: 'pplx_threads_v1'
  };

  const DEFAULT_SETTINGS = {
    model: 'sonar',
    search_mode: 'web',
    stream: true,
    stream_mode: 'full',
    max_tokens: null,
    reasoning_effort: null,
    return_images: false,
    return_related_questions: false,
    enable_search_classifier: false,
    disable_search: false,
    safe_search: true,
    web_search_options: {
      search_context_size: null,
      search_type: null
    },
    search_domain_filter: [],
    search_language_filter: [],
    search_recency_filter: null,
    image_domain_filter: [],
    image_format_filter: [],
    media_response: {
      overrides: {
        return_videos: false
      }
    },
    language_preference: null,
    system_prompt: '',
    deep_research_async: true
  };

  /** @type {{apiKey: string, settings: any, threads: any[], activeThreadId: string|null, attachments: {images:any[], files:any[]}}} */
  const state = {
    apiKey: '',
    settings: structuredClone(DEFAULT_SETTINGS),
    threads: [],
    activeThreadId: null,
    attachments: { images: [], files: [] }
  };

  let abortController = null;

  // -------------------- Helpers --------------------
  const $ = (id) => document.getElementById(id);

  function uid() {
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function parseList(text) {
    return String(text || '')
      .split(/[\n,]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function clamp(n, min, max) {
    if (Number.isNaN(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function setStatus(kind, text) {
    const pill = $('statusPill');
    pill.classList.remove('statusPill--idle', 'statusPill--streaming', 'statusPill--error');
    if (kind === 'streaming') pill.classList.add('statusPill--streaming');
    else if (kind === 'error') pill.classList.add('statusPill--error');
    else pill.classList.add('statusPill--idle');
    pill.textContent = text;
  }

  function toast(msg) {
    // Minimal toast: status pill.
    setStatus('idle', msg);
    setTimeout(() => {
      if ($('statusPill').textContent === msg) setStatus('idle', 'Idle');
    }, 2500);
  }

  // -------------------- Persistence --------------------
  function loadPersisted() {
    state.apiKey = localStorage.getItem(LS.apiKey) || '';

    const settingsRaw = localStorage.getItem(LS.settings);
    if (settingsRaw) {
      const parsed = safeJsonParse(settingsRaw);
      if (parsed) state.settings = mergeSettings(structuredClone(DEFAULT_SETTINGS), parsed);
    }

    const threadsRaw = localStorage.getItem(LS.threads);
    if (threadsRaw) {
      const parsed = safeJsonParse(threadsRaw);
      if (Array.isArray(parsed)) state.threads = parsed;
    }

    if (!state.threads.length) {
      const t = createThread();
      state.threads = [t];
      state.activeThreadId = t.id;
      saveThreads();
    } else {
      state.activeThreadId = state.threads[0].id;
    }
  }

  function mergeSettings(base, override) {
    // Shallow-ish merge for this template.
    const out = { ...base, ...override };
    out.web_search_options = { ...base.web_search_options, ...(override.web_search_options || {}) };
    out.media_response = { ...base.media_response, ...(override.media_response || {}) };
    out.media_response.overrides = {
      ...base.media_response.overrides,
      ...((override.media_response || {}).overrides || {})
    };
    return out;
  }

  function saveSettings() {
    localStorage.setItem(LS.settings, JSON.stringify(state.settings));
  }

  function saveThreads() {
    // Persist only "safe" messages: strip any base64/attachment content arrays.
    const safeThreads = state.threads.map((t) => {
      const safeMessages = (t.messages || []).map((m) => {
        const content = m.content;
        if (Array.isArray(content)) {
          // Don't persist base64 blobs.
          return { ...m, content: summarizeMultipartContent(content) };
        }
        return { ...m, content: String(content || '') };
      });
      return { ...t, messages: safeMessages };
    });
    localStorage.setItem(LS.threads, JSON.stringify(safeThreads));
  }

  function summarizeMultipartContent(parts) {
    const textPart = parts.find((p) => p && p.type === 'text');
    const images = parts.filter((p) => p && p.type === 'image_url').length;
    const files = parts.filter((p) => p && p.type === 'file_url').length;
    const head = textPart?.text ? String(textPart.text) : '';
    const extra = [];
    if (images) extra.push(`${images} image(s)`);
    if (files) extra.push(`${files} file(s)`);
    if (!extra.length) return head;
    return `${head}\n\n[Attachments: ${extra.join(', ')}]`;
  }

  // -------------------- Threads --------------------
  function createThread() {
    return {
      id: uid(),
      title: 'New chat',
      createdAt: nowISO(),
      messages: [],
      // In-memory only: messageIndex -> {images:[], files:[]}
      ephemeral: { attachmentsByIndex: {} }
    };
  }

  function activeThread() {
    return state.threads.find((t) => t.id === state.activeThreadId) || null;
  }

  function setActiveThread(id) {
    state.activeThreadId = id;
    render();
  }

  function deleteThread(id) {
    const idx = state.threads.findIndex((t) => t.id === id);
    if (idx < 0) return;
    state.threads.splice(idx, 1);
    if (!state.threads.length) {
      const t = createThread();
      state.threads.push(t);
      state.activeThreadId = t.id;
    } else if (state.activeThreadId === id) {
      state.activeThreadId = state.threads[0].id;
    }
    saveThreads();
    render();
  }

  // -------------------- UI Rendering --------------------
  function renderThreadList() {
    const list = $('threadList');
    list.innerHTML = '';

    for (const t of state.threads) {
      const item = document.createElement('div');
      item.className = 'threadItem' + (t.id === state.activeThreadId ? ' threadItem--active' : '');
      item.addEventListener('click', () => setActiveThread(t.id));

      const left = document.createElement('div');
      left.style.flex = '1';

      const title = document.createElement('div');
      title.className = 'threadItem__title';
      title.textContent = t.title || 'Chat';

      const meta = document.createElement('div');
      meta.className = 'threadItem__meta';
      meta.textContent = `${(t.messages || []).length} msg`;

      left.appendChild(title);
      left.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'threadItem__actions';

      const del = document.createElement('button');
      del.className = 'btn';
      del.textContent = '🗑';
      del.title = 'Delete chat';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete this chat?')) deleteThread(t.id);
      });

      actions.appendChild(del);
      item.appendChild(left);
      item.appendChild(actions);

      list.appendChild(item);
    }
  }

  function renderMessages() {
    const thread = activeThread();
    const container = $('messages');
    container.innerHTML = '';

    if (!thread) return;

    $('threadTitle').textContent = thread.title || 'Chat';

    const msgs = thread.messages || [];
    msgs.forEach((m, idx) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'message ' + (m.role === 'user' ? 'message--user' : 'message--assistant');
      wrapper.id = `msg-${thread.id}-${idx}`;

      const header = document.createElement('div');
      header.className = 'message__header';

      const role = document.createElement('div');
      role.className = 'message__role';
      role.textContent = m.role === 'user' ? 'User' : 'Assistant';

      const tools = document.createElement('div');
      tools.className = 'message__tools';

      if (m.role === 'assistant') {
        const copy = document.createElement('button');
        copy.className = 'btn';
        copy.textContent = 'Copy';
        copy.addEventListener('click', () => {
          navigator.clipboard.writeText(String(m.content || '')).then(() => toast('Copied'));
        });
        tools.appendChild(copy);
      }

      header.appendChild(role);
      header.appendChild(tools);

      const content = document.createElement('div');
      content.className = 'message__content';

      if (m.role === 'assistant') {
        content.innerHTML = renderAssistantHTML(m.content || '', m.meta || {});
      } else {
        // User message: render plain text, preserve newlines.
        const pre = document.createElement('pre');
        pre.style.margin = '0';
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.background = 'transparent';
        pre.style.padding = '0';
        pre.textContent = Array.isArray(m.content) ? summarizeMultipartContent(m.content) : String(m.content || '');
        content.appendChild(pre);

        // Show ephemeral attachments if available.
        const eph = thread.ephemeral?.attachmentsByIndex?.[idx];
        if (eph && (eph.images?.length || eph.files?.length)) {
          const metaWrap = document.createElement('div');
          metaWrap.className = 'message__meta';

          const block = document.createElement('div');
          block.className = 'metaBlock';

          const title = document.createElement('div');
          title.className = 'metaBlock__title';
          title.textContent = 'Attachments';
          block.appendChild(title);

          const chips = document.createElement('div');
          chips.style.display = 'flex';
          chips.style.gap = '6px';
          chips.style.flexWrap = 'wrap';

          for (const img of eph.images || []) {
            const c = document.createElement('span');
            c.className = 'chip';
            c.textContent = `🖼 ${img.name}`;
            chips.appendChild(c);
          }
          for (const f of eph.files || []) {
            const c = document.createElement('span');
            c.className = 'chip';
            c.textContent = `📄 ${f.name}`;
            chips.appendChild(c);
          }
          block.appendChild(chips);
          metaWrap.appendChild(block);
          wrapper.appendChild(metaWrap);
        }
      }

      wrapper.appendChild(header);
      wrapper.appendChild(content);

      // Meta blocks (sources, usage, etc.)
      if (m.role === 'assistant' && m.meta) {
        const meta = renderMetaBlocks(m.meta);
        if (meta) wrapper.appendChild(meta);
      }

      container.appendChild(wrapper);

      // Syntax highlight within this message.
      wrapper.querySelectorAll('pre code').forEach((el) => {
        try {
          hljs.highlightElement(el);
        } catch {
          // ignore
        }
      });

      // Add per-code-block copy buttons
      wrapper.querySelectorAll('pre').forEach((pre) => {
        if (pre.querySelector('.copyBtn')) return;
        const code = pre.querySelector('code');
        if (!code) return;
        pre.classList.add('codeBlock');
        const btn = document.createElement('button');
        btn.className = 'copyBtn';
        btn.textContent = 'Copy code';
        btn.addEventListener('click', () => {
          navigator.clipboard.writeText(code.innerText).then(() => toast('Code copied'));
        });
        pre.appendChild(btn);
      });
    });

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  function renderAssistantHTML(content, meta) {
    const md = String(content || '');
    const rawHtml = marked.parse(md, { mangle: false, headerIds: false });
    let safeHtml = DOMPurify.sanitize(rawHtml);

    // Convert bare [1] [2] ... references into links to citations when possible.
    const citations = Array.isArray(meta?.citations) ? meta.citations : [];
    if (citations.length) {
      safeHtml = safeHtml.replace(/\[(\d{1,3})\]/g, (m, nStr) => {
        const n = Number(nStr);
        if (!Number.isFinite(n) || n < 1 || n > citations.length) return m;
        const url = citations[n - 1];
        return `<a href="${escapeHtmlAttr(url)}" target="_blank" rel="noreferrer">[${n}]</a>`;
      });
    }

    return safeHtml;
  }

  function escapeHtmlAttr(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function renderMetaBlocks(meta) {
    const hasAny =
      (meta.citations && meta.citations.length) ||
      (meta.search_results && meta.search_results.length) ||
      (meta.usage && Object.keys(meta.usage).length) ||
      (meta.reasoning_steps && meta.reasoning_steps.length) ||
      (meta.images && meta.images.length) ||
      (meta.videos && meta.videos.length) ||
      (meta.related_questions && meta.related_questions.length) ||
      meta.async;

    if (!hasAny) return null;

    const wrap = document.createElement('div');
    wrap.className = 'message__meta';

    // Citations
    if (meta.citations && meta.citations.length) {
      const block = document.createElement('div');
      block.className = 'metaBlock';
      block.innerHTML = `
        <div class="metaBlock__title">Citations</div>
        <div class="sources"></div>
      `;
      const sources = block.querySelector('.sources');
      meta.citations.forEach((url, i) => {
        const div = document.createElement('div');
        div.className = 'sourceItem';
        div.innerHTML = `
          <div class="sourceItem__title"><a href="${escapeHtmlAttr(url)}" target="_blank" rel="noreferrer">[${i + 1}] ${escapeHtml(url)}</a></div>
        `;
        sources.appendChild(div);
      });
      wrap.appendChild(block);
    }

    // Search results
    if (meta.search_results && meta.search_results.length) {
      const block = document.createElement('div');
      block.className = 'metaBlock';
      block.innerHTML = `
        <div class="metaBlock__title">Search results</div>
        <div class="sources"></div>
      `;
      const sources = block.querySelector('.sources');
      meta.search_results.forEach((r) => {
        const title = r.title || r.url || 'Result';
        const url = r.url || '';
        const date = r.date || r.last_updated || '';
        const snippet = r.snippet || '';
        const div = document.createElement('div');
        div.className = 'sourceItem';
        div.innerHTML = `
          <div class="sourceItem__title"><a href="${escapeHtmlAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a></div>
          ${snippet ? `<div class="sourceItem__snippet">${escapeHtml(snippet)}</div>` : ''}
          ${date ? `<div class="sourceItem__meta">${escapeHtml(date)}</div>` : ''}
        `;
        sources.appendChild(div);
      });
      wrap.appendChild(block);
    }

    // Reasoning steps (Pro Search)
    if (meta.reasoning_steps && meta.reasoning_steps.length) {
      const block = document.createElement('div');
      block.className = 'metaBlock';
      block.innerHTML = `
        <div class="metaBlock__title">Research steps</div>
        <div class="sources"></div>
      `;
      const sources = block.querySelector('.sources');
      meta.reasoning_steps.forEach((s) => {
        const div = document.createElement('div');
        div.className = 'sourceItem';
        const type = s.type ? String(s.type) : 'step';
        const thought = s.thought ? String(s.thought) : '';
        div.innerHTML = `
          <div class="sourceItem__title">${escapeHtml(type)}</div>
          ${thought ? `<div class="sourceItem__snippet">${escapeHtml(thought)}</div>` : ''}
        `;
        sources.appendChild(div);
      });
      wrap.appendChild(block);
    }

    // Images
    if (meta.images && meta.images.length) {
      const block = document.createElement('div');
      block.className = 'metaBlock';
      block.innerHTML = `
        <div class="metaBlock__title">Images</div>
        <div class="mediaGrid"></div>
      `;
      const grid = block.querySelector('.mediaGrid');
      meta.images.forEach((img) => {
        const url = typeof img === 'string' ? img : (img.url || img.image_url || img.src || '');
        const caption = typeof img === 'string' ? '' : (img.title || img.caption || img.source || '');
        if (!url) return;
        const card = document.createElement('div');
        card.className = 'mediaCard';
        card.innerHTML = `
          <a href="${escapeHtmlAttr(url)}" target="_blank" rel="noreferrer">
            <img src="${escapeHtmlAttr(url)}" alt="" />
          </a>
          <div class="mediaCard__body">${escapeHtml(caption)}</div>
        `;
        grid.appendChild(card);
      });
      wrap.appendChild(block);
    }

    // Videos
    if (meta.videos && meta.videos.length) {
      const block = document.createElement('div');
      block.className = 'metaBlock';
      block.innerHTML = `
        <div class="metaBlock__title">Videos</div>
        <div class="mediaGrid"></div>
      `;
      const grid = block.querySelector('.mediaGrid');
      meta.videos.forEach((v) => {
        const url = v.url || v.video_url || '';
        const thumb = v.thumbnail_url || v.thumbnail || '';
        const caption = v.title || v.source || '';
        if (!url) return;
        const card = document.createElement('div');
        card.className = 'mediaCard';
        card.innerHTML = `
          <a href="${escapeHtmlAttr(url)}" target="_blank" rel="noreferrer">
            ${thumb ? `<img src="${escapeHtmlAttr(thumb)}" alt="" />` : `<div style="padding:12px;">▶️ Open video</div>`}
          </a>
          <div class="mediaCard__body">${escapeHtml(caption)}</div>
        `;
        grid.appendChild(card);
      });
      wrap.appendChild(block);
    }

    // Related questions (best-effort; format isn't always documented)
    if (meta.related_questions && meta.related_questions.length) {
      const block = document.createElement('div');
      block.className = 'metaBlock';
      block.innerHTML = `
        <div class="metaBlock__title">Related questions</div>
        <div id="rq" style="display:flex; flex-wrap:wrap; gap:6px;"></div>
      `;
      const rq = block.querySelector('#rq');
      meta.related_questions.forEach((q) => {
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = q;
        btn.addEventListener('click', () => {
          $('prompt').value = q;
          $('prompt').focus();
        });
        rq.appendChild(btn);
      });
      wrap.appendChild(block);
    }

    // Usage / cost
    if (meta.usage && Object.keys(meta.usage).length) {
      const block = document.createElement('div');
      block.className = 'metaBlock';
      const u = meta.usage;
      const cost = u.cost || {};
      const lines = [
        u.prompt_tokens != null ? `Prompt tokens: ${u.prompt_tokens}` : null,
        u.completion_tokens != null ? `Completion tokens: ${u.completion_tokens}` : null,
        u.total_tokens != null ? `Total tokens: ${u.total_tokens}` : null,
        u.search_context_size ? `Search context size: ${u.search_context_size}` : null,
        cost.total_cost != null ? `Total cost: ${cost.total_cost}` : null
      ].filter(Boolean);

      block.innerHTML = `
        <div class="metaBlock__title">Usage</div>
        <pre style="margin:0;">${escapeHtml(lines.join('\n') || JSON.stringify(u, null, 2))}</pre>
      `;
      wrap.appendChild(block);
    }

    // Async status
    if (meta.async) {
      const block = document.createElement('div');
      block.className = 'metaBlock';
      block.innerHTML = `
        <div class="metaBlock__title">Async deep research</div>
        <div style="color: var(--muted); font-size: 13px;">${escapeHtml(meta.async)}</div>
      `;
      wrap.appendChild(block);
    }

    return wrap;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function renderAttachmentPreview() {
    const p = $('attachmentPreview');
    p.innerHTML = '';

    const items = [
      ...state.attachments.images.map((x) => ({ ...x, kind: 'image' })),
      ...state.attachments.files.map((x) => ({ ...x, kind: 'file' }))
    ];

    for (const it of items) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${it.kind === 'image' ? '🖼' : '📄'} ${it.name}`;
      p.appendChild(chip);
    }
  }

  function render() {
    renderThreadList();
    renderMessages();
    renderAttachmentPreview();
  }

  // -------------------- Modals / Settings --------------------
  function openApiKeyModal() {
    $('apiKeyModal').style.display = 'grid';
    $('apiKeyInput').value = state.apiKey || '';
    $('apiKeyInput').focus();
  }

  function closeApiKeyModal() {
    $('apiKeyModal').style.display = 'none';
  }

  function saveApiKeyFromModal() {
    state.apiKey = $('apiKeyInput').value.trim();
    if (state.apiKey) localStorage.setItem(LS.apiKey, state.apiKey);
    else localStorage.removeItem(LS.apiKey);
    closeApiKeyModal();
    toast(state.apiKey ? 'API key saved' : 'API key cleared');
  }

  function clearApiKey() {
    state.apiKey = '';
    localStorage.removeItem(LS.apiKey);
    $('apiKeyInput').value = '';
    toast('API key cleared');
  }

  function openSettings() {
    const s = state.settings;

    $('modelSelect').value = s.model;
    $('searchMode').value = s.search_mode;
    $('streamToggle').value = String(Boolean(s.stream));
    $('streamMode').value = s.stream_mode || 'full';
    $('maxTokens').value = s.max_tokens ?? '';
    $('reasoningEffort').value = s.reasoning_effort ?? '';

    $('returnImages').value = String(Boolean(s.return_images));
    $('returnVideos').value = String(Boolean(s.media_response?.overrides?.return_videos));
    $('returnRelated').value = String(Boolean(s.return_related_questions));
    $('enableSearchClassifier').value = String(Boolean(s.enable_search_classifier));
    $('disableSearch').value = String(Boolean(s.disable_search));
    $('safeSearch').value = String(Boolean(s.safe_search));

    $('searchContextSize').value = s.web_search_options?.search_context_size ?? '';
    $('searchType').value = s.web_search_options?.search_type ?? '';

    $('languagePreference').value = s.language_preference ?? '';
    $('systemPrompt').value = s.system_prompt ?? '';

    $('searchDomainFilter').value = (s.search_domain_filter || []).join('\n');
    $('searchLanguageFilter').value = (s.search_language_filter || []).join(', ');
    $('searchRecency').value = s.search_recency_filter ?? '';

    $('imageDomainFilter').value = (s.image_domain_filter || []).join('\n');
    $('imageFormatFilter').value = (s.image_format_filter || []).join('\n');

    $('deepResearchAsync').value = String(Boolean(s.deep_research_async));

    $('settingsDrawer').style.display = 'grid';
  }

  function closeSettings() {
    $('settingsDrawer').style.display = 'none';
  }

  function readSettingsFromUI() {
    const s = structuredClone(DEFAULT_SETTINGS);

    s.model = $('modelSelect').value;
    s.search_mode = $('searchMode').value;

    s.stream = $('streamToggle').value === 'true';
    s.stream_mode = $('streamMode').value;

    const maxTokens = $('maxTokens').value.trim();
    s.max_tokens = maxTokens ? clamp(Number(maxTokens), 1, 128000) : null;

    const re = $('reasoningEffort').value;
    s.reasoning_effort = re || null;

    s.return_images = $('returnImages').value === 'true';
    s.media_response.overrides.return_videos = $('returnVideos').value === 'true';

    s.return_related_questions = $('returnRelated').value === 'true';
    s.enable_search_classifier = $('enableSearchClassifier').value === 'true';
    s.disable_search = $('disableSearch').value === 'true';
    s.safe_search = $('safeSearch').value === 'true';

    const scs = $('searchContextSize').value;
    s.web_search_options.search_context_size = scs || null;

    const st = $('searchType').value;
    s.web_search_options.search_type = st || null;

    const lp = $('languagePreference').value.trim();
    s.language_preference = lp || null;

    s.system_prompt = $('systemPrompt').value;

    s.search_domain_filter = parseList($('searchDomainFilter').value);
    s.search_language_filter = parseList($('searchLanguageFilter').value);

    const rec = $('searchRecency').value;
    s.search_recency_filter = rec || null;

    s.image_domain_filter = parseList($('imageDomainFilter').value);
    s.image_format_filter = parseList($('imageFormatFilter').value);

    s.deep_research_async = $('deepResearchAsync').value === 'true';

    return s;
  }

  // -------------------- Attachments --------------------
  async function fileToBase64(file, { dataUri }) {
    const buf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    if (dataUri) {
      return `data:${file.type};base64,${b64}`;
    }
    return b64;
  }

  async function onImagePicked(files) {
    const arr = Array.from(files || []);
    if (!arr.length) return;

    for (const f of arr) {
      // Keep it in memory; do not persist.
      const dataUrl = await fileToBase64(f, { dataUri: true });
      state.attachments.images.push({ name: f.name, type: f.type, dataUrl });
    }
    renderAttachmentPreview();
  }

  async function onFilePicked(files) {
    const arr = Array.from(files || []);
    if (!arr.length) return;

    for (const f of arr) {
      // Docs: Perplexity expects base64 *without* a data: prefix.
      const base64 = await fileToBase64(f, { dataUri: false });
      state.attachments.files.push({ name: f.name, type: f.type, base64 });
    }
    renderAttachmentPreview();
  }

  function clearAttachments() {
    state.attachments.images = [];
    state.attachments.files = [];
    $('imageInput').value = '';
    $('fileInput').value = '';
    renderAttachmentPreview();
  }

  // -------------------- Request building --------------------
  function buildPayload(thread) {
    const s = state.settings;

    // Clone messages, but for any user messages that were "summarized" due to persistence, keep as text.
    // Note: In-memory messages can still include multipart arrays.
    const msgs = (thread.messages || []).map((m) => {
      if (m.role === 'system') return m;
      if (Array.isArray(m.content)) return { role: m.role, content: m.content };
      return { role: m.role, content: String(m.content || '') };
    });

    const messages = [];
    if (s.system_prompt && s.system_prompt.trim()) {
      messages.push({ role: 'system', content: s.system_prompt.trim() });
    }
    messages.push(...msgs);

    const payload = {
      model: s.model,
      messages,
      search_mode: s.search_mode,
      stream: Boolean(s.stream),
      stream_mode: s.stream_mode || 'full',
      safe_search: Boolean(s.safe_search)
    };

    if (s.max_tokens != null) payload.max_tokens = s.max_tokens;
    if (s.reasoning_effort) payload.reasoning_effort = s.reasoning_effort;
    if (s.language_preference) payload.language_preference = s.language_preference;

    // Search controls
    if (s.return_images) payload.return_images = true;
    if (s.return_related_questions) payload.return_related_questions = true;
    if (s.enable_search_classifier) payload.enable_search_classifier = true;
    if (s.disable_search) payload.disable_search = true;

    if (s.search_domain_filter?.length) payload.search_domain_filter = s.search_domain_filter;
    if (s.search_language_filter?.length) payload.search_language_filter = s.search_language_filter;
    if (s.search_recency_filter) payload.search_recency_filter = s.search_recency_filter;

    if (s.image_domain_filter?.length) payload.image_domain_filter = s.image_domain_filter;
    if (s.image_format_filter?.length) payload.image_format_filter = s.image_format_filter;

    // Web search options (context size, pro/fast/auto)
    const wso = {};
    if (s.web_search_options?.search_context_size) wso.search_context_size = s.web_search_options.search_context_size;
    if (s.web_search_options?.search_type) wso.search_type = s.web_search_options.search_type;
    if (Object.keys(wso).length) payload.web_search_options = wso;

    // Media response overrides (videos)
    if (s.media_response?.overrides?.return_videos) {
      payload.media_response = { overrides: { return_videos: true } };
    }

    return payload;
  }

  function buildUserMessage(text) {
    const hasAttachments = state.attachments.images.length || state.attachments.files.length;
    if (!hasAttachments) return { role: 'user', content: text };

    const parts = [];
    if (text && text.trim()) {
      parts.push({ type: 'text', text });
    } else {
      parts.push({ type: 'text', text: 'Please analyze the attached files/images.' });
    }

    for (const img of state.attachments.images) {
      parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    }

    for (const f of state.attachments.files) {
      parts.push({ type: 'file_url', file_url: { url: f.base64 } });
    }

    return { role: 'user', content: parts };
  }

  // -------------------- Streaming (SSE) --------------------
  async function consumeSSE(resp, onChunk) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split into SSE events. Each event separated by double newline.
      const events = buffer.split(/\n\n/);
      buffer = events.pop() || '';

      for (const evt of events) {
        const lines = evt
          .split(/\n/)
          .map((l) => l.trim())
          .filter(Boolean);

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') return;

          const obj = safeJsonParse(data);
          if (obj) onChunk(obj);
        }
      }
    }
  }

  // -------------------- Sending --------------------
  async function sendPrompt() {
    const thread = activeThread();
    if (!thread) return;

    if (!state.apiKey) {
      openApiKeyModal();
      return;
    }

    const promptEl = $('prompt');
    const text = promptEl.value;
    const hasText = Boolean(text && text.trim());
    const hasAttachments = state.attachments.images.length || state.attachments.files.length;

    if (!hasText && !hasAttachments) return;

    // Abort any in-flight
    if (abortController) {
      try { abortController.abort(); } catch {}
    }

    const userMsg = buildUserMessage(text);
    const userIndex = thread.messages.length;

    // Store attachments in memory for display/context (not persisted)
    if (Array.isArray(userMsg.content)) {
      thread.ephemeral.attachmentsByIndex[userIndex] = {
        images: [...state.attachments.images],
        files: [...state.attachments.files]
      };
    }

    thread.messages.push(userMsg);

    const assistantMsg = {
      role: 'assistant',
      content: '',
      meta: {
        citations: [],
        search_results: [],
        usage: {},
        reasoning_steps: [],
        images: [],
        videos: [],
        related_questions: []
      }
    };
    const assistantIndex = thread.messages.length;
    thread.messages.push(assistantMsg);

    // Update title if first message
    if (thread.title === 'New chat' && hasText) {
      thread.title = text.trim().slice(0, 42) + (text.trim().length > 42 ? '…' : '');
    }

    promptEl.value = '';
    clearAttachments();

    saveThreads();
    render();

    setStatus('streaming', 'Streaming…');
    $('stopBtn').style.display = 'inline-flex';

    abortController = new AbortController();

    try {
      // Deep research async mode (best effort)
      if (state.settings.model === 'sonar-deep-research' && state.settings.deep_research_async) {
        await runDeepResearchAsync(thread, assistantIndex, abortController.signal);
      } else {
        await runChatCompletion(thread, assistantIndex, abortController.signal);
      }

      setStatus('idle', 'Done');
    } catch (err) {
      if (err?.name === 'AbortError') {
        setStatus('idle', 'Stopped');
      } else {
        console.error(err);
        setStatus('error', 'Error');
        // Show error in assistant message.
        assistantMsg.content += `\n\n⚠️ ${String(err?.message || err)}`;
        renderMessages();
      }
    } finally {
      $('stopBtn').style.display = 'none';
      abortController = null;
      saveThreads();
    }
  }

  async function runChatCompletion(thread, assistantIndex, signal) {
    const payload = buildPayload(thread);

    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pplx-key': state.apiKey
      },
      body: JSON.stringify(payload),
      signal
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Perplexity API error (${resp.status}): ${text}`);
    }

    const assistantMsg = thread.messages[assistantIndex];

    if (payload.stream) {
      await consumeSSE(resp, (chunk) => {
        applyPerplexityChunk(assistantMsg, chunk);
        // Keep the last assistant message updated.
        updateMessageElement(thread, assistantIndex);
      });
    } else {
      const data = await resp.json();
      applyPerplexityFinal(assistantMsg, data);
      updateMessageElement(thread, assistantIndex);
    }
  }

  async function runDeepResearchAsync(thread, assistantIndex, signal) {
    // Submit
    const payload = buildPayload(thread);

    // Async endpoint expects { request: <chat completion payload> }
    const submitResp = await fetch('/api/async/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pplx-key': state.apiKey
      },
      body: JSON.stringify({ request: payload }),
      signal
    });

    if (!submitResp.ok) {
      const text = await submitResp.text();
      throw new Error(`Async submit error (${submitResp.status}): ${text}`);
    }

    const job = await submitResp.json();
    const id = job.id;

    const assistantMsg = thread.messages[assistantIndex];
    assistantMsg.meta.async = `Request created: ${id}. Polling…`;
    assistantMsg.content = assistantMsg.content || '⏳ Deep research is running. This can take a while.';
    updateMessageElement(thread, assistantIndex);

    // Poll
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await sleep(3000);

      const pollResp = await fetch(`/api/async/get/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: {
          'x-pplx-key': state.apiKey
        },
        signal
      });

      if (!pollResp.ok) {
        const text = await pollResp.text();
        throw new Error(`Async poll error (${pollResp.status}): ${text}`);
      }

      const data = await pollResp.json();

      assistantMsg.meta.async = `Status: ${data.status || 'UNKNOWN'} • id: ${id}`;

      if (data.status === 'FAILED') {
        throw new Error(data.error_message || 'Deep research request failed');
      }

      if (data.status === 'COMPLETED' && data.response) {
        // data.response should match chat completion payload.
        applyPerplexityFinal(assistantMsg, data.response);
        assistantMsg.meta.async = `Completed • id: ${id}`;
        updateMessageElement(thread, assistantIndex);
        return;
      }

      // Keep UI fresh
      updateMessageElement(thread, assistantIndex);
    }
  }

  function applyPerplexityChunk(msg, chunk) {
    // Streaming: chunks are chat.completion.chunk objects.
    // Content arrives in choices[0].delta.content.
    const delta = chunk?.choices?.[0]?.delta;
    if (delta?.content) {
      msg.content = String(msg.content || '') + String(delta.content);
    }

    // Final chunks contain metadata.
    if (chunk.citations) msg.meta.citations = chunk.citations;
    if (chunk.search_results) msg.meta.search_results = chunk.search_results;
    if (chunk.usage) msg.meta.usage = chunk.usage;
    if (chunk.reasoning_steps) msg.meta.reasoning_steps = chunk.reasoning_steps;

    // Media (best-effort)
    if (chunk.images) msg.meta.images = chunk.images;
    if (chunk.videos) msg.meta.videos = chunk.videos;

    // Related questions (best-effort)
    if (chunk.related_questions) msg.meta.related_questions = chunk.related_questions;

    // Some implementations may stuff these inside message/delta.
    if (delta?.reasoning_steps) msg.meta.reasoning_steps = delta.reasoning_steps;
  }

  function applyPerplexityFinal(msg, data) {
    const content = data?.choices?.[0]?.message?.content;
    if (content != null) msg.content = String(content);
    if (data?.citations) msg.meta.citations = data.citations;
    if (data?.search_results) msg.meta.search_results = data.search_results;
    if (data?.usage) msg.meta.usage = data.usage;
    if (data?.reasoning_steps) msg.meta.reasoning_steps = data.reasoning_steps;
    if (data?.images) msg.meta.images = data.images;
    if (data?.videos) msg.meta.videos = data.videos;
    if (data?.related_questions) msg.meta.related_questions = data.related_questions;
  }

  function updateMessageElement(thread, idx) {
    const el = document.getElementById(`msg-${thread.id}-${idx}`);
    if (!el) {
      // If not found, re-render all.
      renderMessages();
      return;
    }

    const msg = thread.messages[idx];
    const contentEl = el.querySelector('.message__content');
    if (msg.role === 'assistant') {
      contentEl.innerHTML = renderAssistantHTML(msg.content || '', msg.meta || {});

      // Update meta section by re-rendering for this message.
      // Remove existing meta blocks and re-add.
      const existingMeta = el.querySelector('.message__meta');
      if (existingMeta) existingMeta.remove();
      const newMeta = renderMetaBlocks(msg.meta || {});
      if (newMeta) el.appendChild(newMeta);

      // Highlight code and add copy buttons.
      el.querySelectorAll('pre code').forEach((code) => {
        try { hljs.highlightElement(code); } catch {}
      });
      el.querySelectorAll('pre').forEach((pre) => {
        if (pre.querySelector('.copyBtn')) return;
        const code = pre.querySelector('code');
        if (!code) return;
        pre.classList.add('codeBlock');
        const btn = document.createElement('button');
        btn.className = 'copyBtn';
        btn.textContent = 'Copy code';
        btn.addEventListener('click', () => {
          navigator.clipboard.writeText(code.innerText).then(() => toast('Code copied'));
        });
        pre.appendChild(btn);
      });

      // Scroll to bottom
      const container = $('messages');
      container.scrollTop = container.scrollHeight;
    }
  }

  // -------------------- Export --------------------
  function exportActiveChat() {
    const t = activeThread();
    if (!t) return;

    const lines = [];
    lines.push(`# ${t.title || 'Chat'}`);
    lines.push('');
    lines.push(`Exported: ${new Date().toISOString()}`);
    lines.push('');

    t.messages.forEach((m) => {
      lines.push(`## ${m.role === 'user' ? 'User' : 'Assistant'}`);
      lines.push('');
      if (Array.isArray(m.content)) lines.push(summarizeMultipartContent(m.content));
      else lines.push(String(m.content || ''));
      lines.push('');

      if (m.role === 'assistant' && m.meta) {
        if (m.meta.citations?.length) {
          lines.push('### Citations');
          m.meta.citations.forEach((c, i) => lines.push(`- [${i + 1}] ${c}`));
          lines.push('');
        }
        if (m.meta.search_results?.length) {
          lines.push('### Search results');
          m.meta.search_results.forEach((r) => lines.push(`- ${r.title || r.url} — ${r.url}`));
          lines.push('');
        }
      }
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(t.title || 'chat').replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 48)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // -------------------- Wire up events --------------------
  function wireEvents() {
    $('newChatBtn').addEventListener('click', () => {
      const t = createThread();
      state.threads.unshift(t);
      state.activeThreadId = t.id;
      saveThreads();
      render();
    });

    $('apiKeyBtn').addEventListener('click', openApiKeyModal);
    $('closeApiKeyBtn').addEventListener('click', closeApiKeyModal);
    $('saveApiKeyBtn').addEventListener('click', saveApiKeyFromModal);
    $('clearApiKeyBtn').addEventListener('click', clearApiKey);

    $('settingsBtn').addEventListener('click', openSettings);
    $('closeSettingsBtn').addEventListener('click', closeSettings);

    $('saveSettingsBtn').addEventListener('click', () => {
      state.settings = readSettingsFromUI();
      saveSettings();
      closeSettings();
      toast('Settings saved');
    });

    $('resetSettingsBtn').addEventListener('click', () => {
      state.settings = structuredClone(DEFAULT_SETTINGS);
      saveSettings();
      openSettings();
      toast('Settings reset');
    });

    $('exportBtn').addEventListener('click', exportActiveChat);

    $('sendBtn').addEventListener('click', sendPrompt);

    $('prompt').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      }
    });

    $('stopBtn').addEventListener('click', () => {
      if (abortController) abortController.abort();
    });

    $('imageInput').addEventListener('change', (e) => onImagePicked(e.target.files));
    $('fileInput').addEventListener('change', (e) => onFilePicked(e.target.files));

    // Close drawers/modals on backdrop click
    $('apiKeyModal').querySelector('.modal__backdrop').addEventListener('click', closeApiKeyModal);
    $('settingsDrawer').querySelector('.drawer__backdrop').addEventListener('click', closeSettings);
  }

  // -------------------- Init --------------------
  function init() {
    loadPersisted();
    wireEvents();
    render();

    if (!state.apiKey) {
      openApiKeyModal();
    }
  }

  init();
})();
