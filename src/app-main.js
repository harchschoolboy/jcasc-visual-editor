/* Code panel, issues list, top bar, layout and bootstrap. */
(function () {
  'use strict';
  const C = window.JcascCore;
  const App = window.App;
  const { S, h, $, $$, esc } = App;

  // ---------- YAML highlighting ----------
  function hlValue(v) {
    if (!v) return '';
    const m = v.match(/^(.*?)(\s+#.*)?$/);
    let body = m[1];
    const comment = m[2] || '';
    let e = esc(body).replace(/\$\{[^}]*\}/g, (x) => `<span class="v">${x}</span>`);
    if (/^\s*["']/.test(body)) e = `<span class="s">${e}</span>`;
    else if (/^\s*(true|false|null|~|-?\d+(\.\d+)?)\s*$/.test(body)) e = `<span class="b">${e}</span>`;
    else if (/^\s*[>|][-+]?\s*$/.test(body)) e = `<span class="d">${e}</span>`;
    return e + (comment ? `<span class="c">${esc(comment)}</span>` : '');
  }

  function hl(line) {
    if (/^\s*#/.test(line)) return `<span class="c">${esc(line)}</span>`;
    const m = line.match(/^(\s*(?:- )*)([^\s"'#:][^:#]*?|"[^"]*"|'[^']*')(:)(\s.*|$)/);
    if (m) return esc(m[1]) + `<span class="k">${esc(m[2])}</span>` + m[3] + hlValue(m[4]);
    const d = line.match(/^(\s*(?:- )+)(.*)$/);
    if (d) return esc(d[1]) + hlValue(d[2]);
    return hlValue(line);
  }

  // ---------- locating the selected item in the YAML text ----------
  const indentOf = (s) => s.length - s.trimStart().length;

  /** Sequence items under the "key:" line at `keyLine`. Returns item start lines and block end. */
  function seqItems(lines, keyLine, limit) {
    const items = [];
    let itemIndent = -1;
    let end = keyLine + 1;
    const keyIndent = indentOf(lines[keyLine]) + (lines[keyLine].trimStart().startsWith('- ') ? 2 : 0);
    for (; end < limit; end++) {
      const l = lines[end];
      if (!l.trim() || /^\s*#/.test(l)) continue;
      const ind = indentOf(l);
      const dash = l.trimStart().startsWith('- ') || l.trim() === '-';
      if (itemIndent === -1) {
        if (!dash || ind < keyIndent) break;
        itemIndent = ind;
      }
      if (ind < itemIndent || (ind === itemIndent && !dash)) break;
      if (ind === itemIndent && dash) items.push(end);
    }
    while (end - 1 > keyLine && !lines[end - 1].trim()) end--;
    return { items, end };
  }

  function rangeOfItem(lines, keyRe, index) {
    const kl = lines.findIndex((l) => keyRe.test(l));
    if (kl === -1) return null;
    const { items, end } = seqItems(lines, kl, lines.length);
    if (index >= items.length) return null;
    let stop = index + 1 < items.length ? items[index + 1] : end;
    while (stop - 1 > items[index] && !lines[stop - 1].trim()) stop--;
    return [items[index], stop];
  }

  function selectedRange(lines) {
    if (S.mode === 'views') return rangeOfItem(lines, /^\s*views:\s*$/, S.selView);
    if (S.mode === 'roles') {
      if (!S.selRole) return null;
      const al = lines.findIndex((l) => /^\s*authorizationStrategy:\s*$/.test(l));
      if (al === -1) return null;
      const typeRe = new RegExp('^\\s*' + S.selRole[0] + ':\\s*$');
      let tl = -1;
      for (let i = al + 1; i < lines.length; i++) {
        if (lines[i].trim() && indentOf(lines[i]) <= indentOf(lines[al])) break;
        if (typeRe.test(lines[i])) { tl = i; break; }
      }
      if (tl === -1) return null;
      const { items, end } = seqItems(lines, tl, lines.length);
      const ri = S.selRole[1];
      if (ri >= items.length) return null;
      let stop = ri + 1 < items.length ? items[ri + 1] : end;
      while (stop - 1 > items[ri] && !lines[stop - 1].trim()) stop--;
      return [items[ri], stop];
    }
    if (!S.selCred) return null;
    const [di, ci] = S.selCred;
    const dr = rangeOfItem(lines, /^\s*domainCredentials:\s*$/, di);
    if (!dr) return null;
    let cl = -1;
    for (let i = dr[0]; i < dr[1]; i++) if (/^\s*(- )?credentials:\s*$/.test(lines[i])) { cl = i; break; }
    if (cl === -1) return null;
    const { items, end } = seqItems(lines, cl, dr[1]);
    if (ci >= items.length) return null;
    let stop = ci + 1 < items.length ? items[ci + 1] : end;
    while (stop - 1 > items[ci] && !lines[stop - 1].trim()) stop--;
    return [items[ci], stop];
  }

  // ---------- code panel ----------
  let lastSelKey = null;

  function renderCode() {
    const pre = $('#code');
    const stat = $('#codeStat');
    $$('#codeModes button').forEach((b) => b.classList.toggle('on', b.dataset.code === S.codeMode));
    if (!S.model) { pre.innerHTML = ''; stat.textContent = ''; return; }
    if (S.outputError) {
      pre.innerHTML = `<div class="code-error">${esc(S.outputError)}</div>`;
      stat.textContent = 'error';
      return;
    }
    const rows = [];
    let outLines;
    let adds = 0;
    let dels = 0;
    if (S.codeMode === 'views' || S.codeMode === 'creds' || S.codeMode === 'auth') {
      const t = C.sectionText(S.model, S.styles, S.codeMode).replace(/\n$/, '');
      outLines = t.split('\n');
      outLines.forEach((text, i) => rows.push({ cls: '', no: i + 1, b: i, sg: '', text }));
      stat.textContent = `${outLines.length} lines`;
    } else {
      outLines = S.output.replace(/\r\n/g, '\n').split('\n');
      const ops = C.diffLines(S.source, S.output);
      ops.forEach((o) => { if (o.type === 'add') adds++; else if (o.type === 'del') dels++; });
      if (S.codeMode === 'full') {
        ops.forEach((o) => rows.push({
          cls: o.type === 'same' ? '' : o.type, no: o.type === 'del' ? '' : o.b + 1, b: o.b, sg: o.type === 'add' ? '+' : o.type === 'del' ? '−' : '', text: o.text,
        }));
      } else {
        const CTX = 3;
        const keep = new Array(ops.length).fill(false);
        ops.forEach((o, i) => {
          if (o.type === 'same') return;
          for (let k = Math.max(0, i - CTX); k <= Math.min(ops.length - 1, i + CTX); k++) keep[k] = true;
        });
        let prev = -2;
        ops.forEach((o, i) => {
          if (!keep[i]) return;
          if (i !== prev + 1) {
            const firstB = ops.slice(i).find((x) => x.b !== undefined);
            rows.push({ cls: 'hunk', no: '', sg: '', text: `@@ line ${firstB ? firstB.b + 1 : '?'} @@`, raw: true });
          }
          prev = i;
          rows.push({ cls: o.type === 'same' ? '' : o.type, no: o.type === 'del' ? '' : o.b + 1, b: o.b, sg: o.type === 'add' ? '+' : o.type === 'del' ? '−' : '', text: o.text });
        });
        if (!rows.length) rows.push({ cls: 'hunk', no: '', sg: '', text: 'No changes yet — edit views, credentials or roles on the left.', raw: true });
      }
      stat.textContent = adds || dels ? `+${adds} −${dels}` : 'no changes';
    }

    const range = selectedRange(outLines);
    const html = rows.map((r) => {
      const sel = range && r.b !== undefined && r.cls !== 'del' && r.b >= range[0] && r.b < range[1];
      return `<div class="ln ${r.cls}${sel ? ' sel' : ''}"${r.b !== undefined && r.cls !== 'del' ? ` data-b="${r.b}"` : ''}>`
        + `<span class="no">${r.no}</span><span class="sg">${r.sg}</span>`
        + `<span class="tx">${r.raw ? esc(r.text) : hl(r.text)}</span></div>`;
    }).join('');
    pre.innerHTML = html;

    const selKey = S.codeMode + '|' + S.mode + '|' + (S.mode === 'views' ? S.selView : S.mode === 'roles' ? String(S.selRole) : String(S.selCred));
    const first = pre.querySelector('.ln.sel');
    if (first) {
      const wrap = $('#codeWrap');
      const top = first.offsetTop;
      const visible = top >= wrap.scrollTop && top < wrap.scrollTop + wrap.clientHeight - 20;
      if (selKey !== lastSelKey) {
        wrap.scrollTop = Math.max(0, top - 60);
        pre.querySelectorAll('.ln.sel').forEach((el) => el.classList.add('flash'));
      } else if (!visible) {
        wrap.scrollTop = Math.max(0, top - 60);
      }
    }
    lastSelKey = selKey;
  }

  App.codeShownText = function () {
    if (S.codeMode === 'views' || S.codeMode === 'creds' || S.codeMode === 'auth') return C.sectionText(S.model, S.styles, S.codeMode);
    return S.output;
  };

  // ---------- issues ----------
  function renderIssues() {
    const box = $('#issues');
    box.textContent = '';
    const area = S.mode;
    const list = S.issues.filter((i) => i.area === area);
    const order = { error: 0, warn: 1, info: 2 };
    list.sort((a, b) => order[a.level] - order[b.level]);
    const n = (lv) => list.filter((i) => i.level === lv).length;
    box.classList.toggle('collapsed', !S.issuesOpen);
    box.append(h('div', { class: 'ihead', onclick: () => { S.issuesOpen = !S.issuesOpen; renderIssues(); } },
      S.issuesOpen ? '▾' : '▸',
      `Checks (${{ views: 'views', creds: 'credentials', roles: 'roles' }[area]})`,
      h('span', { style: { color: 'var(--err)' } }, `${n('error')} errors`),
      h('span', { style: { color: 'var(--warn)' } }, `${n('warn')} warnings`),
      h('span', { class: 'muted' }, `${n('info')} info`)));
    box.append(h('div', { class: 'ilist' }, list.map((it) => h('div', {
      class: 'issue',
      onclick: () => {
        const t = it.target || {};
        if (t.view !== undefined) App.selectView(t.view);
        else if (t.cred) App.selectCred(t.cred[0], t.cred[1]);
        else if (t.role) App.selectRole(t.role[0], t.role[1]);
        else if (t.principal) App.selectPrincipal(t.principal);
        else if (t.ref) { S.credQuery = ''; App.toast(`"${t.ref}" is used by jobs but missing in credentials`); }
      },
    }, h('span', { class: 'lv ' + it.level }), it.msg)),
    list.length ? null : h('div', { class: 'muted', style: { padding: '4px' } }, 'No problems found.')));
  }

  // ---------- top bar ----------
  App.renderTop = function () {
    const info = $('#fileInfo');
    info.textContent = '';
    const dirty = App.dirty();
    if (S.model) {
      info.append(h('span', { class: 'chip' + (App.isDirty() ? ' dirty' : ''), title: S.fileHandle ? 'Save writes back to this file' : 'Opened without a file handle — Save will ask where to write' },
        (App.isDirty() ? '● ' : '') + S.fileName + (S.fileHandle ? '' : ' (no handle)')));
    }
    if (S.scan) {
      info.append(h('span', { class: 'chip link', title: 'Jobs source settings', onclick: App.openJobsDialog },
        `Jobs: ${S.jobs.length} from ${S.jobsFolderName}${S.excluded.size ? ` (−${S.excluded.size} dirs)` : ''} ▾`));
    }
    $('#btnRescan').hidden = !S.scan;
    $('#btnUndo').disabled = !S.history.length;
    $('#btnRedo').disabled = !S.future.length;
    $('#btnReset').disabled = !App.isDirty();
    $('#btnSave').disabled = !S.model;
    $('#btnDownload').disabled = !S.model;
    $('#btnCopy').disabled = !S.model;
    $('#btnCode').classList.toggle('on', S.codeOpen);
    document.body.classList.toggle('code-hidden', !S.codeOpen);

    const badges = $('#dirtyBadges');
    if (badges) {
      badges.textContent = '';
      if (dirty.views || dirty.tabBar) badges.append(h('span', { class: 'badge changed' }, 'views changed'));
      if (dirty.creds) badges.append(h('span', { class: 'badge changed' }, 'credentials changed'));
      if (dirty.auth) badges.append(h('span', { class: 'badge changed' }, 'roles changed'));
    }
  };

  // ---------- main render ----------
  App.render = function (full) {
    App.recompute();
    App.renderTop();
    const has = !!S.model;
    $('#welcome').hidden = has;
    $('#workspace').hidden = !has;
    if (has) {
      $$('.modes .mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.mode));
      $('#viewsPane').classList.toggle('active', S.mode === 'views');
      $('#credsPane').classList.toggle('active', S.mode === 'creds');
      $('#rolesPane').classList.toggle('active', S.mode === 'roles');
      $('#cntViews').textContent = S.model.views.length;
      $('#cntCreds').textContent = S.model.domains.reduce((n, d) => n + d.credentials.length, 0);
      $('#cntRoles').textContent = C.ROLE_TYPES.reduce((n, t) => n + S.model.auth.roles[t].length, 0);
      if (S.mode === 'views') App.renderViews(full);
      else if (S.mode === 'roles') App.renderRoles(full);
      else App.renderCreds(full);
      renderIssues();
    }
    renderCode();
    App.persistSoon();
  };

  App.setMode = function (mode) {
    S.mode = mode;
    if (mode === 'creds' && !S.selCred) S.selCred = App.firstCred();
    const SECTION = { views: 'views', creds: 'creds', roles: 'auth' };
    if (Object.values(SECTION).includes(S.codeMode)) S.codeMode = SECTION[mode];
    App.render(true);
  };

  // ---------- layout ----------
  function setupSplitter() {
    const sp = $('#splitter');
    const apply = () => { if (S.codeWidth) document.documentElement.style.setProperty('--code-w', S.codeWidth + 'px'); };
    apply();
    sp.addEventListener('mousedown', (e) => {
      e.preventDefault();
      sp.classList.add('drag');
      const move = (ev) => {
        S.codeWidth = Math.max(280, Math.min(window.innerWidth - 440, window.innerWidth - ev.clientX));
        apply();
      };
      const up = () => {
        sp.classList.remove('drag');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        App.persistSoon();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  function setupKeys() {
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); App.save(); }
      else if (k === 'z' && !e.shiftKey) { e.preventDefault(); App.undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); App.redo(); }
    });
  }

  function bind() {
    $('#btnOpen').onclick = App.openJcasc;
    $('#btnPaste').onclick = App.pasteJcasc;
    $('#btnJobs').onclick = App.pickJobsFolder;
    $('#btnRescan').onclick = App.rescanJobs;
    $('#btnUndo').onclick = App.undo;
    $('#btnRedo').onclick = App.redo;
    $('#btnReset').onclick = App.reset;
    $('#btnSave').onclick = App.save;
    $('#btnDownload').onclick = App.download;
    $('#btnCopy').onclick = () => S.model && App.copyText(S.output, 'resulting YAML');
    $('#btnCopyCode').onclick = () => S.model && App.copyText(App.codeShownText(), 'code');
    $('#btnCode').onclick = () => { S.codeOpen = !S.codeOpen; App.renderTop(); if (S.codeOpen) renderCode(); App.persistSoon(); };
    $$('#codeModes button').forEach((b) => { b.onclick = () => { S.codeMode = b.dataset.code; renderCode(); App.persistSoon(); }; });
    $$('.modes .mode').forEach((b) => { b.onclick = () => App.setMode(b.dataset.mode); });
    $$('#welcome [data-action]').forEach((b) => {
      b.onclick = () => ({ open: App.openJcasc, paste: App.pasteJcasc, jobs: App.pickJobsFolder })[b.dataset.action]();
    });
  }

  function init() {
    bind();
    App.setupIO();
    App.setupCreds();
    App.setupRoles();
    setupSplitter();
    setupKeys();
    const restored = App.restore();
    App.render(true);
    if (restored) {
      App.restoreHandles();
      if (S.model) App.toast(`Restored previous session (${S.fileName}${App.isDirty() ? ', unsaved edits' : ''})`);
    }
  }

  init();
})();
