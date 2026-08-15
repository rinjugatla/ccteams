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

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));

describe('version sync between package.json and plugin.json', () => {
  test('package.json version is valid semver', () => {
    const { version } = readJson(PACKAGE_JSON_PATH);
    assert.match(
      version,
      SEMVER_RE,
      `package.json "version" (${version}) is not in x.y.z semver format`,
    );
  });

  test('plugin.json version is valid semver', () => {
    const { version } = readJson(PLUGIN_JSON_PATH);
    assert.match(
      version,
      SEMVER_RE,
      `plugin.json "version" (${version}) is not in x.y.z semver format`,
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
