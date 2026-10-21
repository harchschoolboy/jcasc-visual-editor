/* Shared state, DOM helpers, history and persistence. */
(function () {
  'use strict';
  const C = window.JcascCore;
  const App = (window.App = {});

  App.$ = (s, r) => (r || document).querySelector(s);
  App.$$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'draggable', 'hidden', 'open', 'indeterminate']);

  /** Tiny hyperscript: h('div', {class:'x', onclick: fn}, 'text', child, [more]) */
  App.h = function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    const append = (k) => {
      if (k == null || k === false) return;
      if (Array.isArray(k)) k.forEach(append);
      else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    };
    kids.forEach(append);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    return el;
  };

  App.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  App.ci = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });

  let toastTimer = null;
  App.toast = function (msg, kind) {
    const t = App.$('#toast');
    t.textContent = msg;
    t.className = kind || '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 6000 : 2800);
  };

  // ---------- state ----------
  const S = (App.S = {
    source: null,
    fileName: '',
    fileHandle: null,
    dirHandle: null,
    styles: {},
    base: null,
    model: null,
    jcascRefs: [],
    scan: null, // { jobs, refs, groups }
    excluded: new Set(),
    jobs: [],
    refs: [],
    jobsLoaded: false,
    jobsFolderName: '',
    mode: 'views',
    selView: 0,
    selCred: null, // [domainIndex, credIndex]
    selRole: null, // [type, index]
    selPrincipal: null, // "user:alice"
    rolesView: 'users', // 'users' | 'perms'
    mergeRoles: true,
    principalQuery: '',
    pendingPrincipals: [], // added in the UI but not yet in any role
    codeMode: 'full',
    codeOpen: true,
    codeWidth: null,
    output: '',
    outputError: null,
    issues: [],
    evals: [],
    history: [],
    future: [],
    lastKey: null,
    lastAt: 0,
    jobQuery: '',
    credQuery: '',
    orphansOpen: true,
    issuesOpen: true,
  });

  App.snapshot = (m) => ({ views: JSON.stringify(m.views), tabBar: m.viewsTabBar, creds: JSON.stringify(m.domains), auth: JSON.stringify(m.auth) });

  App.dirty = function () {
    if (!S.model || !S.base) return { views: false, tabBar: false, creds: false, auth: false };
    return {
      views: JSON.stringify(S.model.views) !== S.base.views,
      tabBar: S.model.viewsTabBar !== S.base.tabBar,
      creds: JSON.stringify(S.model.domains) !== S.base.creds,
      auth: JSON.stringify(S.model.auth) !== S.base.auth,
    };
  };

  App.isDirty = () => { const d = App.dirty(); return d.views || d.tabBar || d.creds || d.auth; };

  /** All job names the views are evaluated against. */
  App.universe = function () {
    const map = new Map();
    if (S.jobsLoaded) {
      for (const j of S.jobs) if (!map.has(j.name.toLowerCase())) map.set(j.name.toLowerCase(), j.name);
    } else if (S.model) {
      for (const v of S.model.views) {
        if (v.type !== 'list' || !Array.isArray(v.cfg.jobNames)) continue;
        for (const n of v.cfg.jobNames) if (!map.has(String(n).toLowerCase())) map.set(String(n).toLowerCase(), String(n));
      }
    }
    return Array.from(map.values()).sort(App.ci);
  };

  App.jobInfo = function (name) {
    const lower = name.toLowerCase();
    return S.jobs.find((j) => j.name.toLowerCase() === lower) || null;
  };

  App.allRefs = () => S.refs.concat(S.jcascRefs);

  App.recompute = function () {
    if (!S.model) return;
    const d = App.dirty();
    try {
      S.output = C.generate(S.source, S.model, S.styles, d);
      S.outputError = null;
    } catch (e) {
      S.outputError = e.message;
    }
    const U = App.universe();
    S.evals = S.model.views.map((v) => C.evaluateView(v, U));
    S.issues = C.lint(S.model, { jobNames: U, jobsLoaded: S.jobsLoaded, refs: App.allRefs() });
  };

  // ---------- history ----------
  /**
   * Mutate the model. `key` coalesces rapid edits of one field into a single undo step;
   * `full: false` keeps the focused form intact and only refreshes live parts.
   */
  App.change = function (fn, opts) {
    const o = opts || {};
    const now = Date.now();
    if (!(o.key && o.key === S.lastKey && now - S.lastAt < 1200)) {
      S.history.push(JSON.stringify(S.model));
      if (S.history.length > 300) S.history.shift();
      S.future = [];
    }
    S.lastKey = o.key || null;
    S.lastAt = now;
    fn(S.model);
    App.render(o.full !== false);
  };

  App.undo = function () {
    if (!S.history.length) return;
    S.future.push(JSON.stringify(S.model));
    S.model = JSON.parse(S.history.pop());
    S.lastKey = null;
    App.clampSelection();
    App.render(true);
  };

  App.redo = function () {
    if (!S.future.length) return;
    S.history.push(JSON.stringify(S.model));
    S.model = JSON.parse(S.future.pop());
    S.lastKey = null;
    App.clampSelection();
    App.render(true);
  };

  App.clampSelection = function () {
    if (!S.model) return;
    S.selView = Math.max(0, Math.min(S.selView, S.model.views.length - 1));
    if (S.selCred) {
      const [di, ci] = S.selCred;
      const d = S.model.domains[di];
      if (!d || !d.credentials[ci]) S.selCred = App.firstCred();
    }
    if (S.selRole) {
      const list = S.model.auth && S.model.auth.roles[S.selRole[0]];
      if (!list || !list[S.selRole[1]]) S.selRole = null;
    }
  };

  App.firstCred = function () {
    if (!S.model) return null;
    for (let di = 0; di < S.model.domains.length; di++) {
      if (S.model.domains[di].credentials.length) return [di, 0];
    }
    return null;
  };

  // ---------- persistence ----------
  const LS_KEY = 'jcasc-visual-editor:v1';
  let persistTimer = null;

  App.persistSoon = function () {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(App.persist, 400);
  };

  App.persist = function () {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        source: S.source,
        fileName: S.fileName,
        model: S.model,
        scan: S.scan,
        excluded: Array.from(S.excluded),
        jobsLoaded: S.jobsLoaded,
        jobsFolderName: S.jobsFolderName,
        mode: S.mode,
        selView: S.selView,
        selCred: S.selCred,
        selRole: S.selRole,
        selPrincipal: S.selPrincipal,
        rolesView: S.rolesView,
        mergeRoles: S.mergeRoles,
        codeMode: S.codeMode,
        codeOpen: S.codeOpen,
        codeWidth: S.codeWidth,
      }));
    } catch (e) {
      console.warn('Cannot persist state', e);
    }
  };

  App.restore = function () {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved) return false;
    S.codeMode = saved.codeMode || 'full';
    S.codeOpen = saved.codeOpen !== false;
    S.codeWidth = saved.codeWidth || null;
    S.mode = saved.mode || 'views';
    if (saved.scan) {
      S.scan = saved.scan;
      S.excluded = new Set(saved.excluded || []);
      S.jobsLoaded = !!saved.jobsLoaded;
      S.jobsFolderName = saved.jobsFolderName || '';
      App.deriveJobs();
    }
    if (saved.source != null) {
      try {
        const parsed = C.parseJcasc(saved.source);
        S.source = saved.source;
        S.fileName = saved.fileName || 'jcasc.yml';
        S.styles = parsed.styles;
        S.base = App.snapshot(parsed.model);
        S.model = saved.model || parsed.model;
        if (!S.model.auth) S.model.auth = parsed.model.auth;
        S.jcascRefs = C.scanJcascRefs(saved.source, S.fileName);
        S.selView = saved.selView || 0;
        S.selCred = saved.selCred || App.firstCred();
        S.selRole = saved.selRole || null;
        S.selPrincipal = saved.selPrincipal || null;
        S.rolesView = saved.rolesView || 'users';
        S.mergeRoles = saved.mergeRoles !== false;
        App.clampSelection();
      } catch (e) {
        console.warn('Cannot restore JCasC', e);
      }
    }
    return !!(S.model || S.scan);
  };

  App.forget = function () {
    localStorage.removeItem(LS_KEY);
    App.idb.del('file');
    App.idb.del('dir');
  };

  // File System Access handles survive reloads only via IndexedDB.
  App.idb = {
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open('jcasc-visual-editor', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async run(mode, fn) {
      try {
        const db = await this.open();
        return await new Promise((res, rej) => {
          const tx = db.transaction('kv', mode);
          const req = fn(tx.objectStore('kv'));
          tx.oncomplete = () => res(req && req.result);
          tx.onerror = () => rej(tx.error);
        });
      } catch (e) {
        return undefined;
      }
    },
    get(k) { return this.run('readonly', (s) => s.get(k)); },
    set(k, v) { return this.run('readwrite', (s) => s.put(v, k)); },
    del(k) { return this.run('readwrite', (s) => s.delete(k)); },
  };
})();
