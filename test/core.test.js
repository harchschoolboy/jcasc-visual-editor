const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const C = require('../src/core.js');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'jcasc.yml'), 'utf8').replace(/\r\n/g, '\n');
const all = { views: true, tabBar: true, creds: true };

test('no edits returns the source unchanged', () => {
  const p = C.parseJcasc(fixture);
  assert.equal(C.generate(fixture, p.model, p.styles, { views: false, tabBar: false, creds: false }), fixture);
});

test('regenerating unchanged sections is byte-identical (quotes, blank lines kept)', () => {
  const p = C.parseJcasc(fixture);
  assert.equal(C.generate(fixture, p.model, p.styles, all), fixture);
});

test('editing a view only touches the views block', () => {
  const p = C.parseJcasc(fixture);
  p.model.views[0].cfg.jobNames.push('Q - New');
  p.model.views[1].cfg.name = 'Prod';
  const out = C.generate(fixture, p.model, p.styles, { views: true, tabBar: false, creds: false });
  const ops = C.diffLines(fixture, out).filter((o) => o.type !== 'same');
  assert.deepEqual(ops.map((o) => o.type + o.text.trim()).sort(), [
    'add- "Q - New"', 'addname: "Prod"', 'delname: "Production"',
  ].sort());
  assert.ok(out.includes('numExecutors: 2 # keep me'));
  assert.ok(out.includes('# trailing comment'));
  assert.deepEqual(YAML.parse(out).jenkins.views[1], { list: { columns: ['status'], includeRegex: 'P - .*', name: 'Prod' } });
});

test('editing credentials keeps per-type quoting', () => {
  const p = C.parseJcasc(fixture);
  p.model.domains[0].credentials.push({ type: 'string', cfg: { scope: 'GLOBAL', id: 'new', secret: '${NEW}' }, space: true });
  const out = C.generate(fixture, p.model, p.styles, { views: false, tabBar: false, creds: true });
  assert.ok(out.includes('              username: git\n'));
  assert.ok(out.includes('              username: "git"\n'));
  assert.ok(out.includes('\n\n          - string:\n              scope: GLOBAL\n              id: "new"\n              secret: ${NEW}\n'));
  assert.equal(YAML.parse(out).credentials.system.domainCredentials[0].credentials.length, 3);
});

test('inserts views and credentials when they are missing', () => {
  const src = 'jenkins:\n  numExecutors: 1\n\nunclassified:\n  foo: 1\n';
  const p = C.parseJcasc(src);
  p.model.views.push({ type: 'list', cfg: { name: 'A', jobNames: ['x'] }, space: false });
  p.model.domains.push({ extra: {}, credentials: [{ type: 'string', cfg: { id: 'c', secret: '${S}' }, space: false }] });
  const out = C.generate(src, p.model, p.styles, { views: true, tabBar: false, creds: true });
  const js = YAML.parse(out);
  assert.equal(js.jenkins.numExecutors, 1);
  assert.equal(js.unclassified.foo, 1);
  assert.deepEqual(js.jenkins.views, [{ list: { name: 'A', jobNames: ['x'] } }]);
  assert.equal(js.credentials.system.domainCredentials[0].credentials[0].string.id, 'c');
  assert.ok(out.startsWith('jenkins:\n  numExecutors: 1\n  views:\n'));
});

test('works on an empty document', () => {
  const p = C.parseJcasc('');
  p.model.views.push({ type: 'all', cfg: { name: 'all' }, space: false });
  const out = C.generate('', p.model, p.styles, { views: true, tabBar: false, creds: false });
  assert.deepEqual(YAML.parse(out), { jenkins: { views: [{ all: { name: 'all' } }] } });
});

test('preserves CRLF line endings', () => {
  const crlf = fixture.replace(/\n/g, '\r\n');
  const p = C.parseJcasc(crlf);
  p.model.views[0].cfg.name = 'Develop';
  const out = C.generate(crlf, p.model, p.styles, all);
  assert.ok(!/[^\r]\n/.test(out));
  assert.equal(YAML.parse(out).jenkins.views[0].list.name, 'Develop');
});

test('evaluateView mimics Jenkins ListView matching', () => {
  const p = C.parseJcasc(fixture);
  const jobs = ['U - Build', 'U - Deploy', 'P - Release', 'XP - Release', 'Q - Other'];
  const dev = C.evaluateView(p.model.views[0], jobs);
  assert.deepEqual(dev.rows.map((r) => r.name), ['U - Build', 'U - Deploy']);
  assert.deepEqual(dev.missing, []);
  const prod = C.evaluateView(p.model.views[1], jobs);
  assert.deepEqual(prod.rows.map((r) => r.name), ['P - Release']);
  const allV = C.evaluateView(p.model.views[2], jobs);
  assert.equal(allV.rows.length, jobs.length);
  assert.equal(C.compileJavaRegex('(?i)p - .*').re.test('P - X'), true);
  assert.ok(C.compileJavaRegex('(').error);
});

test('scanJobFiles finds job names and credential references', () => {
  const r = C.scanJobFiles([{
    path: 'jobs/a/definition.groovy',
    text: "// pipelineJob('Commented')\npipelineJob('Q - A') {\n  credentials('Git Access')\n}\nqueue('Q - A')\n",
  }, {
    path: 'jobs/a/pipeline.groovy',
    text: "withCredentials([string(credentialsId: 'API', variable: 'T')]) {}\nsshagent(credentials: [\"x\"])\n",
  }]);
  assert.deepEqual(r.jobs.map((j) => j.name), ['Q - A']);
  assert.deepEqual(r.refs.map((x) => x.id).sort(), ['API', 'Git Access']);
});

test('lint reports duplicates, regex-looking names, plain secrets and undefined refs', () => {
  const p = C.parseJcasc(fixture);
  p.model.views[0].cfg.jobNames.push('Q - EDEC .*');
  p.model.domains[0].credentials.push({ type: 'string', cfg: { id: 'API', secret: 'hunter2' }, space: false });
  const issues = C.lint(p.model, {
    jobNames: ['U - Build'],
    jobsLoaded: true,
    refs: [{ id: 'Missing', path: 'jobs/x/pipeline.groovy', line: 3 }],
  });
  const msgs = issues.map((i) => i.msg).join('\n');
  assert.match(msgs, /looks like a regex/);
  assert.match(msgs, /Duplicate credential id "API"/);
  assert.match(msgs, /plain-text secret/);
  assert.match(msgs, /"Missing" is referenced/);
  assert.match(msgs, /job "u - deploy" not found/);
});

const rolesYaml = `jenkins:
  numExecutors: 2
  authorizationStrategy:
    roleBased:
      roles:
        global:
          - entries:
              - user: "alice@x.com"
              - user: "bob@x.com"
            name: "read"
            pattern: ".*"
            permissions:
              - "Overall/Read"
        items:
          - entries:
              - user: "alice@x.com"
              - group: "devs"
            name: "dev"
            pattern: "U - .*"
            permissions:
              - "Job/Build"
              - "Job/Read"
          - name: "empty"
            pattern: "Z - .*"
            permissions:
              - "Job/Read"
  securityRealm:
    local: {}
`;
const allRoles = { views: false, tabBar: false, creds: false, auth: true };

test('roles: regenerating unchanged roleBased is byte-identical', () => {
  const p = C.parseJcasc(rolesYaml);
  assert.equal(p.model.auth.kind, 'roleBased');
  assert.deepEqual(p.model.auth.types, ['global', 'items']);
  assert.equal(C.generate(rolesYaml, p.model, p.styles, allRoles), rolesYaml);
});

test('roles: toggling membership edits entries and keeps key order', () => {
  const p = C.parseJcasc(rolesYaml);
  const R = p.model.auth.roles;
  C.setRoleMember(R.items[1], { kind: 'user', sid: 'bob@x.com' }, true);
  C.setRoleMember(R.items[0], { kind: 'group', sid: 'devs' }, false);
  C.setRoleMember(R.global[0], { kind: 'user', sid: 'bob@x.com' }, true); // already there: no-op
  assert.deepEqual(Object.keys(R.items[1].cfg), ['entries', 'name', 'pattern', 'permissions']);
  const out = C.generate(rolesYaml, p.model, p.styles, allRoles);
  const js = YAML.parse(out).jenkins.authorizationStrategy.roleBased.roles;
  assert.deepEqual(js.items[0].entries, [{ user: 'alice@x.com' }]);
  assert.deepEqual(js.items[1].entries, [{ user: 'bob@x.com' }]);
  assert.ok(out.includes('              - user: "bob@x.com"\n            name: "empty"'));
  assert.ok(out.endsWith('  securityRealm:\n    local: {}\n'));
  // Removing the last member drops the key.
  C.setRoleMember(R.items[1], { kind: 'user', sid: 'bob@x.com' }, false);
  assert.equal(R.items[1].cfg.entries, undefined);
});

test('roles: legacy assignments format is supported', () => {
  const role = { cfg: { name: 'r', assignments: ['alice', 'GROUP:devs'] } };
  assert.deepEqual(C.roleMembers(role.cfg), [{ kind: 'ambiguous', sid: 'alice' }, { kind: 'group', sid: 'devs' }]);
  C.setRoleMember(role, { kind: 'user', sid: 'bob' }, true);
  C.setRoleMember(role, { kind: 'group', sid: 'devs' }, false);
  assert.deepEqual(role.cfg.assignments, ['alice', 'USER:bob']);
});

test('roles: principals, effective access and lint', () => {
  const p = C.parseJcasc(rolesYaml);
  const ps = C.listPrincipals(p.model.auth).map((x) => x.key);
  assert.deepEqual(ps, ['user:alice@x.com', 'user:bob@x.com', 'group:devs']);
  const jobs = ['U - One', 'U - Two', 'P - Prod'];
  const acc = C.principalAccess(p.model.auth, 'user:alice@x.com', jobs);
  assert.deepEqual(Array.from(acc.global), ['Overall/Read']);
  assert.deepEqual(Array.from(acc.jobs.keys()), ['U - One', 'U - Two']);
  assert.deepEqual(Array.from(acc.jobs.get('U - One')).sort(), ['Job/Build', 'Job/Read']);
  const issues = C.lint(p.model, { jobNames: jobs, jobsLoaded: true, refs: [] }).filter((i) => i.area === 'roles');
  const msgs = issues.map((i) => i.msg).join('\n');
  assert.match(msgs, /devs has item\/agent roles but no global role with Overall\/Read/);
  assert.match(msgs, /items role "empty" has no members/);
  assert.match(msgs, /items role "empty": pattern matches no jobs/);
});

test('roles: adding roles when no authorizationStrategy exists', () => {
  const src = 'jenkins:\n  numExecutors: 2\n';
  const p = C.parseJcasc(src);
  assert.equal(p.model.auth.kind, 'none');
  p.model.auth.kind = 'roleBased';
  p.model.auth.roles.global.push({ cfg: { name: 'admin', pattern: '.*', permissions: ['Overall/Administer'], entries: [{ user: 'a' }] }, space: false });
  const out = C.generate(src, p.model, p.styles, allRoles);
  assert.deepEqual(YAML.parse(out).jenkins.authorizationStrategy.roleBased.roles.global[0].name, 'admin');
  assert.ok(out.startsWith('jenkins:\n  numExecutors: 2\n  authorizationStrategy:\n    roleBased:\n'));
});
