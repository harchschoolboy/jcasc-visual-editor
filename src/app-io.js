/* Loading JCasC / jobs folders, saving and exporting. */
(function () {
  'use strict';
  const C = window.JcascCore;
  const App = window.App;
  const { S, h, $, toast } = App;

  const SKIP_DIRS = /^(\.git|node_modules|\.idea|\.vscode|target|build)$/i;
  const DEFAULT_EXCLUDED = /deprecat|archiv|^old$|backup|obsolete/i;
  const isJobFile = (name) => /\.(groovy|dsl|jenkinsfile)$/i.test(name) || name === 'Jenkinsfile';
  const isYaml = (name) => /\.ya?ml$/i.test(name);
  const looksLikeJcasc = (text) => /^(jenkins|credentials|unclassified):\s*$/m.test(text);

  // ---------- JCasC ----------
  App.loadJcasc = function (text, name, handle) {
    let parsed;
    try {
      parsed = C.parseJcasc(text);
    } catch (e) {
      toast(e.message, 'err');
      return false;
    }
    S.source = text;
    S.fileName = name || 'jcasc.yml';
    S.fileHandle = handle || null;
    S.styles = parsed.styles;
    S.base = App.snapshot(parsed.model);
    S.model = parsed.model;
    S.jcascRefs = C.scanJcascRefs(text, S.fileName);
    S.history = [];
    S.future = [];
    S.selView = 0;
    S.selCred = App.firstCred();
    S.selRole = null;
    S.selPrincipal = null;
    S.pendingPrincipals = [];
    if (handle) App.idb.set('file', handle); else App.idb.del('file');
    App.render(true);
    App.persist();
    toast(`Loaded ${S.fileName}: ${parsed.model.views.length} views, ${parsed.model.domains.reduce((n, d) => n + d.credentials.length, 0)} credentials, ${C.ROLE_TYPES.reduce((n, t) => n + parsed.model.auth.roles[t].length, 0)} roles`);
    return true;
  };

  /** After saving, the written text becomes the new baseline. */
  App.rebase = function (text) {
    const parsed = C.parseJcasc(text);
    S.source = text;
    S.styles = parsed.styles;
    S.base = App.snapshot(parsed.model);
    S.model = parsed.model;
    S.jcascRefs = C.scanJcascRefs(text, S.fileName);
    App.clampSelection();
    App.render(true);
    App.persist();
  };

  App.openJcasc = async function () {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'JCasC YAML', accept: { 'text/yaml': ['.yml', '.yaml'] } }],
        });
        const file = await handle.getFile();
        App.loadJcasc(await file.text(), file.name, handle);
      } catch (e) {
        if (e.name !== 'AbortError') toast(e.message, 'err');
      }
    } else {
      $('#fileInput').click();
    }
  };

  App.pasteJcasc = function () {
    const dlg = $('#pasteDlg');
    $('#pasteText').value = '';
    dlg.returnValue = '';
    dlg.showModal();
    dlg.onclose = () => {
      const text = $('#pasteText').value;
      if (dlg.returnValue === 'ok' && text.trim()) App.loadJcasc(text, 'jcasc.yml', null);
    };
  };

  // ---------- jobs folder ----------
  function groupOf(path) {
    const segs = path.split('/');
    return segs.length > 2 ? segs[1] : '(root)';
  }

  App.deriveJobs = function () {
    if (!S.scan) { S.jobs = []; S.refs = []; return; }
    S.jobs = S.scan.jobs.filter((j) => !S.excluded.has(j.group)).sort((a, b) => App.ci(a.name, b.name));
    S.refs = S.scan.refs.filter((r) => !S.excluded.has(r.group));
  };

  App.ingestJobFiles = function (files, folderName, dirHandle, keepExcluded) {
    const jobs = [];
    const refs = [];
    const groups = {};
    for (const f of files) {
      const group = groupOf(f.path);
      const r = C.scanJobFiles([f]);
      groups[group] = groups[group] || { files: 0, jobs: 0 };
      groups[group].files++;
      groups[group].jobs += r.jobs.length;
      r.jobs.forEach((j) => jobs.push(Object.assign(j, { group })));
      r.refs.forEach((x) => refs.push(Object.assign(x, { group })));
    }
    S.scan = { jobs, refs, groups };
    if (!keepExcluded) S.excluded = new Set(Object.keys(groups).filter((g) => DEFAULT_EXCLUDED.test(g)));
    S.jobsLoaded = true;
    S.jobsFolderName = folderName;
    S.dirHandle = dirHandle || null;
    if (dirHandle) App.idb.set('dir', dirHandle); else App.idb.del('dir');
    App.deriveJobs();
    App.render(true);
    App.persist();
    const skipped = S.excluded.size ? ` (excluded: ${Array.from(S.excluded).join(', ')})` : '';
    toast(`Jobs folder "${folderName}": ${S.jobs.length} jobs from ${files.length} files${skipped}`);
  };

  async function readDirHandle(dh, prefix, out, yamls) {
    for await (const [name, entry] of dh.entries()) {
      if (entry.kind === 'directory') {
        if (!SKIP_DIRS.test(name)) await readDirHandle(entry, prefix + '/' + name, out, yamls);
      } else if (isJobFile(name)) {
        out.push({ path: prefix + '/' + name, text: await (await entry.getFile()).text() });
      } else if (yamls && isYaml(name)) {
        yamls.push({ name, handle: entry, path: prefix + '/' + name });
      }
    }
  }

  async function autoLoadJcasc(yamls) {
    if (S.model || !yamls.length) return;
    yamls.sort((a, b) => (/jcasc|casc/i.test(b.name) ? 1 : 0) - (/jcasc|casc/i.test(a.name) ? 1 : 0));
    for (const y of yamls) {
      const file = y.handle.getFile ? await y.handle.getFile() : y.handle;
      const text = await file.text();
      if (looksLikeJcasc(text)) {
        App.loadJcasc(text, y.name, y.handle.getFile ? y.handle : null);
        return;
      }
    }
  }

  App.pickJobsFolder = async function () {
    if (window.showDirectoryPicker) {
      try {
        const dh = await window.showDirectoryPicker({ id: 'jcasc-jobs', mode: 'read' });
        await App.scanDirHandle(dh, false);
      } catch (e) {
        if (e.name !== 'AbortError') toast(e.message, 'err');
      }
    } else {
      $('#dirInput').click();
    }
  };

  App.scanDirHandle = async function (dh, keepExcluded) {
    const files = [];
    const yamls = [];
    await readDirHandle(dh, dh.name, files, S.model ? null : yamls);
    await autoLoadJcasc(yamls);
    if (!files.length) {
      toast(`No *.groovy / Jenkinsfile files found in "${dh.name}"`, 'err');
      return;
    }
    App.ingestJobFiles(files, dh.name, dh, keepExcluded);
  };

  App.rescanJobs = async function () {
    const dh = S.dirHandle;
    if (!dh) { App.pickJobsFolder(); return; }
    try {
      if (dh.queryPermission && (await dh.queryPermission({ mode: 'read' })) !== 'granted') {
        if ((await dh.requestPermission({ mode: 'read' })) !== 'granted') throw new Error('Permission denied');
      }
      await App.scanDirHandle(dh, true);
    } catch (e) {
      toast('Rescan failed: ' + e.message, 'err');
    }
  };

  async function onDirInput(e) {
    const list = Array.from(e.target.files || []);
    e.target.value = '';
    if (!list.length) return;
    const root = (list[0].webkitRelativePath || list[0].name).split('/')[0];
    const files = [];
    const yamls = [];
    for (const f of list) {
      const rel = f.webkitRelativePath || f.name;
      if (rel.split('/').some((s) => SKIP_DIRS.test(s))) continue;
      if (isJobFile(f.name)) files.push({ path: rel, text: await f.text() });
      else if (!S.model && isYaml(f.name)) yamls.push({ name: f.name, handle: f, path: rel });
    }
    await autoLoadJcasc(yamls);
    if (!files.length) { toast(`No *.groovy files found in "${root}"`, 'err'); return; }
    App.ingestJobFiles(files, root, null);
  }

  App.clearJobs = function () {
    S.scan = null;
    S.jobsLoaded = false;
    S.jobsFolderName = '';
    S.dirHandle = null;
    S.excluded = new Set();
    App.idb.del('dir');
    App.deriveJobs();
    App.render(true);
    App.persist();
  };

  App.openJobsDialog = function () {
    const body = $('#jobsDlgBody');
    body.textContent = '';
    if (!S.scan) {
      body.append(h('p', {}, 'No jobs folder loaded.'));
    } else {
      body.append(
        h('p', { class: 'muted' }, `Folder "${S.jobsFolderName}". Untick sub-folders whose jobs should be ignored:`),
        Object.entries(S.scan.groups).sort((a, b) => App.ci(a[0], b[0])).map(([g, info]) => h('label', {},
          h('input', {
            type: 'checkbox',
            checked: !S.excluded.has(g),
            onchange: (e) => {
              if (e.target.checked) S.excluded.delete(g); else S.excluded.add(g);
              App.deriveJobs();
              App.render(true);
              App.persist();
            },
          }),
          h('span', { class: 'grp' }, g),
          h('span', { class: 'muted' }, `${info.jobs} jobs, ${info.files} files`),
        )),
      );
      const dyn = S.jobs.filter((j) => j.dynamic);
      if (dyn.length) {
        body.append(h('p', { class: 'muted' }, 'Jobs with interpolated names (matched literally): ' + dyn.map((j) => j.name).join(', ')));
      }
      body.append(h('div', { class: 'dlg-actions' },
        S.dirHandle ? h('button', { type: 'button', onclick: () => { $('#jobsDlg').close(); App.rescanJobs(); } }, 'Rescan') : null,
        h('button', { type: 'button', onclick: () => { $('#jobsDlg').close(); App.pickJobsFolder(); } }, 'Pick another folder…'),
        h('button', { type: 'button', class: 'danger', onclick: () => { $('#jobsDlg').close(); App.clearJobs(); } }, 'Unload jobs'),
      ));
    }
    $('#jobsDlg').showModal();
  };

  // ---------- drag & drop ----------
  function readEntry(entry, prefix, out, yamls) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        if (!isJobFile(entry.name) && !isYaml(entry.name)) { resolve(); return; }
        entry.file(async (f) => {
          if (isJobFile(entry.name)) out.push({ path: prefix + entry.name, text: await f.text() });
          else yamls.push({ name: entry.name, handle: f, path: prefix + entry.name });
          resolve();
        }, () => resolve());
      } else if (entry.isDirectory) {
        if (SKIP_DIRS.test(entry.name)) { resolve(); return; }
        const reader = entry.createReader();
        const all = [];
        const next = () => reader.readEntries(async (batch) => {
          if (!batch.length) {
            for (const e of all) await readEntry(e, prefix + entry.name + '/', out, yamls);
            resolve();
          } else { all.push(...batch); next(); }
        }, () => resolve());
        next();
      } else resolve();
    });
  }

  function setupDrop() {
    const overlay = $('#dropOverlay');
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; overlay.hidden = false; } });
    window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; overlay.hidden = true; } });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      const items = Array.from(e.dataTransfer.items || []);
      const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
      const handles = await Promise.all(items.map((i) => (i.getAsFileSystemHandle ? i.getAsFileSystemHandle().catch(() => null) : null)));
      const dirEntry = entries.find((x) => x.isDirectory);
      if (dirEntry) {
        const dh = handles.find((x) => x && x.kind === 'directory');
        if (dh) { await App.scanDirHandle(dh, false); return; }
        const files = [];
        const yamls = [];
        await readEntry(dirEntry, '', files, yamls);
        await autoLoadJcasc(yamls);
        if (files.length) App.ingestJobFiles(files, dirEntry.name, null);
        else toast(`No *.groovy files found in "${dirEntry.name}"`, 'err');
        return;
      }
      const file = e.dataTransfer.files[0];
      if (!file) return;
      const fh = handles.find((x) => x && x.kind === 'file') || null;
      App.loadJcasc(await file.text(), file.name, fh);
    });
  }

  // ---------- export ----------
  App.download = function () {
    if (!S.model) return;
    if (S.outputError) { toast('Cannot export: ' + S.outputError, 'err'); return; }
    const blob = new Blob([S.output], { type: 'text/yaml' });
    const a = h('a', { href: URL.createObjectURL(blob), download: S.fileName || 'jcasc.yml' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };

  App.copyText = async function (text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${what}`);
    } catch (e) {
      const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast(`Copied ${what}`);
    }
  };

  async function ensurePermission(handle) {
    if (!handle.queryPermission) return true;
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  }

  App.save = async function () {
    if (!S.model) return;
    if (S.outputError) { toast('Cannot save: ' + S.outputError, 'err'); return; }
    try {
      let handle = S.fileHandle;
      if (handle && handle.createWritable) {
        if (!(await ensurePermission(handle))) throw new Error('write permission denied');
        const current = await (await handle.getFile()).text();
        if (current !== S.source && current !== S.output
          && !confirm(`${handle.name} was changed on disk since it was loaded.\nOverwrite it anyway?`)) return;
      } else if (window.showSaveFilePicker) {
        handle = await window.showSaveFilePicker({
          suggestedName: S.fileName || 'jcasc.yml',
          types: [{ description: 'JCasC YAML', accept: { 'text/yaml': ['.yml', '.yaml'] } }],
        });
        S.fileHandle = handle;
        S.fileName = handle.name;
        App.idb.set('file', handle);
      } else {
        App.download();
        App.rebase(S.output);
        return;
      }
      const w = await handle.createWritable();
      await w.write(S.output);
      await w.close();
      App.rebase(S.output);
      toast(`Saved ${handle.name}`);
    } catch (e) {
      if (e.name !== 'AbortError') toast('Save failed: ' + e.message, 'err');
    }
  };

  App.reset = function () {
    if (!S.model || !App.isDirty()) return;
    if (!confirm('Discard all edits and return to the loaded file?')) return;
    App.change((m) => {
      const parsed = C.parseJcasc(S.source).model;
      m.views = parsed.views;
      m.viewsTabBar = parsed.viewsTabBar;
      m.domains = parsed.domains;
      m.auth = parsed.auth;
    });
    S.pendingPrincipals = [];
  };

  App.restoreHandles = async function () {
    const fh = await App.idb.get('file');
    if (fh && fh.name === S.fileName) S.fileHandle = fh;
    const dh = await App.idb.get('dir');
    if (dh && dh.name === S.jobsFolderName) S.dirHandle = dh;
    App.renderTop();
  };

  App.setupIO = function () {
    $('#fileInput').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) App.loadJcasc(await f.text(), f.name, null);
    });
    $('#dirInput').addEventListener('change', onDirInput);
    setupDrop();
  };
})();
