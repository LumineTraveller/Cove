import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availableMiddleDockWidth,
  resolveControlBallFit,
} from '../src/features/media/components/controlBallResponsivePolicy';

test('available middle width uses actual occupied boundaries and the current dock center', () => {
  const centered = availableMiddleDockWidth({
    workspaceLeft: 100,
    workspaceRight: 1000,
    dockCenter: 550,
    leftContentRight: 300,
    actionsLeft: 800,
    safetyGap: 10,
  });
  assert.equal(centered, 480);

  const shifted = availableMiddleDockWidth({
    workspaceLeft: 100,
    workspaceRight: 1000,
    dockCenter: 600,
    leftContentRight: 300,
    actionsLeft: 800,
    safetyGap: 10,
  });
  assert.equal(shifted, 380);
  assert.equal(availableMiddleDockWidth({
    workspaceLeft: 100,
    workspaceRight: 1000,
    dockCenter: 220,
    leftContentRight: 300,
    actionsLeft: 800,
  }), 0);
});

test('dock fitting degrades as soon as needed and uses hysteresis to recover', () => {
  assert.equal(resolveControlBallFit(620, 600, 320, 'full'), 'full');
  assert.equal(resolveControlBallFit(599, 600, 320, 'full'), 'compact');
  assert.equal(resolveControlBallFit(319, 600, 320, 'compact'), 'ball');
  assert.equal(resolveControlBallFit(335, 600, 320, 'ball'), 'ball');
  assert.equal(resolveControlBallFit(336, 600, 320, 'ball'), 'compact');
  assert.equal(resolveControlBallFit(615, 600, 320, 'compact'), 'compact');
  assert.equal(resolveControlBallFit(616, 600, 320, 'compact'), 'full');
});

test('minimum window leaves a ball slot alongside long share names and audio controls', () => {
  const availableWidth = availableMiddleDockWidth({
    workspaceLeft: 280,
    workspaceRight: 1100,
    dockCenter: 690,
    leftContentRight: 638,
    actionsLeft: 860,
  });
  assert.ok(availableWidth >= 58);
  assert.equal(resolveControlBallFit(availableWidth, 601, 311, 'full'), 'ball');
});
