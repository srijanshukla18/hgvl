import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JevAnswers } from '../src/main/jev.ts';
import type { HerdrModel, PaneModel } from '../src/main/model.ts';
import { interpretRoute, localRoute, planRoute, worthAsking } from '../src/main/route.ts';

function pane(id: string, agent: string | null, state: PaneModel['state']): PaneModel {
  return { id, agent, label: agent ?? 'terminal', state, focused: false, cells: { x: 0, y: 0, w: 10, h: 10 } };
}

function model(panes: PaneModel[]): HerdrModel {
  return {
    connected: true,
    area: { w: 20, h: 10 },
    cellPx: null,
    chrome: true,
    panes,
    zoomedPaneId: null,
    workspaces: [
      { id: 'w1', label: 'checkout', number: 1, focused: true },
      { id: 'w2', label: 'infra', number: 2, focused: false },
    ],
    tabs: [
      { id: 'w1:t1', label: 'agents', number: 1, workspaceId: 'w1', focused: true },
      { id: 'w1:t2', label: 'api', number: 2, workspaceId: 'w1', focused: false },
    ],
  };
}

const choice = (c: string, p = 0.9) => ({ type: 'choice' as const, choice: c, confidence: p, probabilities: { [c]: p } });

test('local rules: yes answers a waiting agent, other words are a prompt, nothing pointed is refused', () => {
  const m = model([pane('a', 'claude', 'blocked'), pane('b', 'codex', 'working')]);
  assert.deepEqual(localRoute('Yes.', 'a', m), { kind: 'approve', paneId: 'a' });
  assert.deepEqual(localRoute('yes', 'b', m), { kind: 'prompt', paneId: 'b' });
  assert.deepEqual(localRoute('stop', 'b', m), { kind: 'interrupt', paneId: 'b' });
  assert.equal(localRoute('add tests', null, m).kind, 'none');
});

test('the plan only offers answers that make sense right now', () => {
  const m = model([pane('a', 'claude', 'working'), pane('b', 'codex', 'idle'), pane('s', null, 'idle')]);
  const plan = planRoute('go to the api tab', null, m);
  const action = plan.questions.action;
  assert.ok(action.type === 'choice');
  assert.deepEqual(Object.keys(action.criteria).sort(), ['focus_tab', 'focus_workspace', 'prompt', 'stop']);
  // Two agents, nothing pointed: ask which one; the plain shell is never a candidate.
  assert.ok(plan.questions.target?.type === 'choice');
  assert.equal(Object.keys(plan.questions.target.criteria).length, 2);
  assert.ok(worthAsking(plan));
});

test('switching tab or workspace by name', () => {
  const m = model([pane('a', 'claude', 'working')]);
  const plan = planRoute('go to the api tab', null, m);
  const tabKey = [...plan.tabs].find(([, id]) => id === 'w1:t2')![0];
  assert.deepEqual(interpretRoute(plan, { action: choice('focus_tab'), tab: choice(tabKey) }, m), {
    kind: 'focusTab',
    tabId: 'w1:t2',
    label: 'api',
  });
  const wsKey = [...plan.workspaces].find(([, id]) => id === 'w2')![0];
  assert.deepEqual(interpretRoute(plan, { action: choice('focus_workspace'), workspace: choice(wsKey) }, m), {
    kind: 'focusWorkspace',
    workspaceId: 'w2',
    label: 'infra',
  });
});

test('without pointing, Jev picks the agent; pointing always wins', () => {
  const m = model([pane('a', 'claude', 'working'), pane('b', 'codex', 'idle')]);
  const loose = planRoute('tell codex to add tests', null, m);
  const codexKey = [...loose.panes].find(([, id]) => id === 'b')![0];
  const answers: JevAnswers = { action: choice('prompt'), target: choice(codexKey) };
  assert.deepEqual(interpretRoute(loose, answers, m), { kind: 'prompt', paneId: 'b' });
  const pointed = planRoute('tell codex to add tests', 'a', m);
  assert.equal(pointed.questions.target, undefined);
  assert.deepEqual(interpretRoute(pointed, answers, m), { kind: 'prompt', paneId: 'a' });
});

test('unsure commands, or answers to agents that are not waiting, fall back to a prompt', () => {
  const m = model([pane('a', 'claude', 'blocked'), pane('b', 'codex', 'working')]);
  assert.deepEqual(interpretRoute(planRoute('maybe', 'a', m), { action: choice('approve', 0.4) }, m), { kind: 'prompt', paneId: 'a' });
  assert.deepEqual(interpretRoute(planRoute('yes', 'b', m), { action: choice('approve') }, m), { kind: 'prompt', paneId: 'b' });
  assert.deepEqual(interpretRoute(planRoute('yes', 'a', m), { action: choice('approve') }, m), { kind: 'approve', paneId: 'a' });
});

test('a name that is both a tab and a workspace still navigates when the vote splits', () => {
  const m = model([pane('a', 'claude', 'idle')]);
  const plan = planRoute('go to website', 'a', m);
  const tabKey = [...plan.tabs].find(([, id]) => id === 'w1:t2')![0];
  const split = { type: 'choice' as const, choice: 'focus_tab', confidence: 0.3, probabilities: { focus_tab: 0.46, focus_workspace: 0.36, prompt: 0.18 } };
  assert.deepEqual(interpretRoute(plan, { action: split, tab: choice(tabKey) }, m), { kind: 'focusTab', tabId: 'w1:t2', label: 'api' });
});
