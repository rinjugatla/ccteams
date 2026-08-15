/**
 * Tests that package.json and plugins/ccteams/.claude-plugin/plugin.json
 * agree on `version`.
 *
 * Unlike most tests in this suite, this one does NOT build fixtures in a
 * temp directory: the thing under test IS this repository's own metadata,
 * so it reads package.json and plugin.json directly from disk.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const PLUGIN_JSON_PATH = path.join(REPO_ROOT, 'plugins', 'ccteams', '.claude-plugin', 'plugin.json');

/**
 * Deliberately stricter than SemVer: plain MAJOR.MINOR.PATCH only, no
 * prerelease or build identifiers (`1.2.3-beta.1`, `1.2.3+build` are
 * rejected). This project has only ever shipped plain x.y.z versions, and
 * the strict form keeps the equality check below unambiguous. Introducing a
 * prerelease version would trip these tests on purpose — relax the pattern
 * then, as a conscious decision.
 */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));

describe('version sync between package.json and plugin.json', () => {
  test('package.json version is in MAJOR.MINOR.PATCH form', () => {
    const { version } = readJson(PACKAGE_JSON_PATH);
    assert.match(
      version,
      VERSION_RE,
      `package.json "version" (${version}) is not in plain MAJOR.MINOR.PATCH (x.y.z) form`,
    );
  });

  test('plugin.json version is in MAJOR.MINOR.PATCH form', () => {
    const { version } = readJson(PLUGIN_JSON_PATH);
    assert.match(
      version,
      VERSION_RE,
      `plugin.json "version" (${version}) is not in plain MAJOR.MINOR.PATCH (x.y.z) form`,
    );
  });

  test('plugin.json version matches package.json version', () => {
    const { version: packageVersion } = readJson(PACKAGE_JSON_PATH);
    const { version: pluginVersion } = readJson(PLUGIN_JSON_PATH);

    assert.equal(
      pluginVersion,
      packageVersion,
      `plugin.json "version" (${pluginVersion}) does not match package.json "version" (${packageVersion}). ` +
        `Update plugins/ccteams/.claude-plugin/plugin.json's "version" to match package.json's "version".`,
    );
  });
});
