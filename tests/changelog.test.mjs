import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, read } from './helpers.mjs';

const { CHANGELOG } = environment(['changelog']);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parts = (version) => version.match(SEMVER).slice(1).map(Number);

test('the newest changelog entry is the version being deployed', () => {
  const { version } = JSON.parse(read('package.json'));
  assert.equal(CHANGELOG[0].version, version, 'a release with visible changes adds a changelog entry for its version');
  const assets = [...read('index.html').matchAll(/\?v=([\d.]+)"/g)].map((m) => m[1]);
  assert.ok(assets.length > 0);
  assert.deepEqual([...new Set(assets)], [version], 'every ?v= in index.html carries the package version');
});

test('changelog releases are newest first, dated and described in short lines', () => {
  for (const [i, release] of CHANGELOG.entries()) {
    assert.match(release.version, SEMVER, release.version);
    assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/, release.version);
    assert.ok(Number.isFinite(Date.parse(release.date)), release.version);
    assert.ok(release.changes.length > 0, `${release.version} lists its changes`);
    for (const change of release.changes) assert.ok(change.trim() && change.length <= 160, `${release.version}: keep it short: ${change}`);
    if (i === 0) continue;
    const [newer, older] = [parts(CHANGELOG[i - 1].version), parts(release.version)];
    assert.ok((newer[0] - older[0] || newer[1] - older[1] || newer[2] - older[2]) > 0, `${CHANGELOG[i - 1].version} comes before ${release.version}`);
    assert.ok(CHANGELOG[i - 1].date >= release.date, `${release.version} is dated no later than the release above it`);
  }
});
