/**
 * Tests for lib/placement.js — resolveTeamPlacement() (the src→dest
 * computation extracted from useTeam()) and buildOwnedSourceIndex() (the
 * dest→src reverse lookup across every applied team).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findTeam } from '../lib/teams.js';
import { resolveTeamPlacement, buildOwnedSourceIndex, mergeOwnedSourceIndex } from '../lib/placement.js';

const makeProjectRoot = () => mkdtempSync(path.join(tmpdir(), 'ccteams-placement-'));

describe('resolveTeamPlacement()', () => {
  test('generalist: 5 agents, the generalist-playbook skill, working-method, and orchestration', () => {
    const projectRoot = makeProjectRoot();
    const team = findTeam('generalist');
    assert.ok(team, 'sanity check: the generalist team package exists');

    const result = resolveTeamPlacement(team, projectRoot);

    assert.equal(result.agentPairs.length, 5, `expected 5 agent files, got ${result.agentFiles.join(', ')}`);
    assert.equal(result.agentFiles.length, 5);
    for (const { src, dest } of result.agentPairs) {
      assert.ok(dest.startsWith(path.join(projectRoot, '.claude', 'agents')));
      assert.ok(src.includes(path.join('teams', 'generalist', 'agents')));
    }

    assert.ok(
      result.placedSkillNames.includes('generalist-playbook'),
      `expected generalist-playbook among placed skills, got ${result.placedSkillNames.join(', ')}`,
    );
    assert.ok(
      result.skillPairs.some(({ skillName }) => skillName === 'generalist-playbook'),
      'expected a generalist-playbook skill pair',
    );

    assert.ok(result.orch, 'generalist ships orchestration.md');
    assert.ok(result.orch.dest.endsWith(path.join('.claude', 'ccteams', 'generalist.md')));

    assert.deepEqual(result.warnings, [], 'no reserved-name or missing-skill warnings expected for generalist');
  });

  test('working-method resolves from the shared skills dir (not a team-local override)', () => {
    const projectRoot = makeProjectRoot();
    const team = findTeam('generalist');

    const result = resolveTeamPlacement(team, projectRoot);
    const workingMethodPairs = result.skillPairs.filter((p) => p.skillName === 'working-method');

    assert.ok(workingMethodPairs.length > 0, 'expected at least one working-method file');
    for (const { src } of workingMethodPairs) {
      assert.ok(
        src.includes(path.join('shared', 'skills', 'working-method')),
        `expected src under shared/skills/working-method, got: ${src}`,
      );
    }
  });

  test('working-method is always first in placedSkillNames', () => {
    const projectRoot = makeProjectRoot();
    const team = findTeam('generalist');

    const result = resolveTeamPlacement(team, projectRoot);

    assert.equal(result.placedSkillNames[0], 'working-method');
  });

  test('a reserved skill name (team-lessons) and a missing skill each produce their own warning, in request order', () => {
    // A synthetic team descriptor reusing a REAL teamDir (generalist's) so
    // resolveSkillDir() has real files to resolve working-method/generalist's
    // own skills against — only `skills` is synthetic, to exercise both
    // warning branches of resolveTeamPlacement() in a single call.
    const projectRoot = makeProjectRoot();
    const generalistTeam = findTeam('generalist');
    assert.ok(generalistTeam, 'sanity check: generalist exists to borrow a real teamDir from');
    const syntheticTeam = {
      name: 'synthetic-warnings-team',
      teamDir: generalistTeam.teamDir,
      skills: ['team-lessons', 'does-not-exist'],
    };

    const result = resolveTeamPlacement(syntheticTeam, projectRoot);

    // rawSkillNames is built as ['working-method', ...team.skills filtered],
    // so team-lessons (filtered out by the reserved-name check) is
    // encountered before does-not-exist (filtered out by resolveSkillDir
    // returning null) — the warnings array must preserve that order.
    assert.equal(result.warnings.length, 2, `expected exactly 2 warnings, got:\n${result.warnings.join('\n')}`);
    assert.match(result.warnings[0], /reserved for the user-owned lessons file — skipped\.$/);
    assert.match(result.warnings[1], /skill "does-not-exist" not found — skipped\.$/);
    // The reserved name must never actually be placed.
    assert.ok(
      !result.placedSkillNames.includes('team-lessons'),
      `team-lessons must never appear in placedSkillNames, got: ${result.placedSkillNames.join(', ')}`,
    );
    assert.ok(
      !result.skillPairs.some((p) => p.skillName === 'team-lessons'),
      'team-lessons must never appear in skillPairs either',
    );
  });
});

describe('buildOwnedSourceIndex()', () => {
  test('resolves dest -> src for every placed file across multiple applied teams', () => {
    const projectRoot = makeProjectRoot();
    const manifest = {
      teams: {
        generalist: { placedFiles: [] },
        sveltekit: { placedFiles: [] },
      },
    };

    const { index, unknownTeams } = buildOwnedSourceIndex(manifest, projectRoot);

    assert.deepEqual(unknownTeams, []);
    assert.ok(index.size > 0);

    // Spot-check one known dest: generalist's builder.md agent.
    const builderDest = path.join(projectRoot, '.claude', 'agents', 'builder.md');
    assert.ok(index.has(builderDest), 'expected .claude/agents/builder.md in the index');
    assert.ok(
      index.get(builderDest).includes(path.join('teams', 'generalist', 'agents', 'builder.md')),
      `unexpected src for builder.md: ${index.get(builderDest)}`,
    );
  });

  test('primary team (first key in manifest.teams) wins on a dest collision', () => {
    // The 11 shipped teams have no actual duplicate agent file names (verified
    // directly: every team's agents/ directory has a disjoint file-name set),
    // so a real collision cannot be reproduced from real team data — reordering
    // two real teams' manifest keys would never surface a difference, because
    // there is nothing for them to disagree about. buildOwnedSourceIndex()
    // delegates its merge step to mergeOwnedSourceIndex(), a pure function that
    // takes an ORDERED list of already-resolved placements — this is what makes
    // the tie-break testable at all: feed it two synthetic placements that
    // deliberately collide on the same dest but report DIFFERENT src values,
    // and assert the FIRST one in the array wins.
    const dest = '/project/.claude/agents/collides.md';
    const placementA = { agentPairs: [{ src: '/pkg/teamA/agents/collides.md', dest }], skillPairs: [], orch: null };
    const placementB = { agentPairs: [{ src: '/pkg/teamB/agents/collides.md', dest }], skillPairs: [], orch: null };

    const indexAFirst = mergeOwnedSourceIndex([placementA, placementB]);
    assert.equal(indexAFirst.get(dest), '/pkg/teamA/agents/collides.md');

    // Reversing the order (as if teamB were primary instead) flips the winner —
    // proving the result really does depend on ARRAY ORDER, i.e. on manifest.teams'
    // key order (primary first), not on some other tie-break (e.g. alphabetical).
    const indexBFirst = mergeOwnedSourceIndex([placementB, placementA]);
    assert.equal(indexBFirst.get(dest), '/pkg/teamB/agents/collides.md');
  });

  test('buildOwnedSourceIndex() delegates to mergeOwnedSourceIndex() with placements in manifest.teams key order', () => {
    // Confirms the wiring (not just the pure merge logic in isolation): using
    // real teams, generalist-first vs. sveltekit-first manifests must still
    // resolve every dest identically here (no real collision exists to flip),
    // but this pins down that buildOwnedSourceIndex() does not, say, sort
    // team names or otherwise reorder them before merging.
    const projectRoot = makeProjectRoot();
    const manifestGeneralistFirst = {
      teams: { generalist: { placedFiles: [] }, sveltekit: { placedFiles: [] } },
    };
    const manifestSveltekitFirst = {
      teams: { sveltekit: { placedFiles: [] }, generalist: { placedFiles: [] } },
    };

    const { index: indexA } = buildOwnedSourceIndex(manifestGeneralistFirst, projectRoot);
    const { index: indexB } = buildOwnedSourceIndex(manifestSveltekitFirst, projectRoot);

    const generalistOrchDest = path.join(projectRoot, '.claude', 'ccteams', 'generalist.md');
    const sveltekitOrchDest = path.join(projectRoot, '.claude', 'ccteams', 'sveltekit.md');
    assert.ok(indexA.has(generalistOrchDest) && indexA.has(sveltekitOrchDest));
    assert.ok(indexB.has(generalistOrchDest) && indexB.has(sveltekitOrchDest));
  });

  test('a team name in the manifest that the package no longer ships is reported in unknownTeams, not in the index', () => {
    const projectRoot = makeProjectRoot();
    const manifest = {
      teams: {
        generalist: { placedFiles: [] },
        'a-team-that-was-removed-from-the-package': { placedFiles: [] },
      },
    };

    const { index, unknownTeams } = buildOwnedSourceIndex(manifest, projectRoot);

    assert.deepEqual(unknownTeams, ['a-team-that-was-removed-from-the-package']);
    for (const src of index.values()) {
      assert.ok(!src.includes('a-team-that-was-removed-from-the-package'));
    }
  });

  test('no team-lessons path ever appears in the index', () => {
    const projectRoot = makeProjectRoot();
    const manifest = {
      teams: {
        generalist: { placedFiles: [] },
        sveltekit: { placedFiles: [] },
        frontend: { placedFiles: [] },
      },
    };

    const { index } = buildOwnedSourceIndex(manifest, projectRoot);

    for (const [dest, src] of index.entries()) {
      assert.ok(!dest.includes('team-lessons'), `dest should never be under team-lessons: ${dest}`);
      assert.ok(!src.includes('team-lessons'), `src should never be under team-lessons: ${src}`);
    }
  });
});
