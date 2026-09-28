// Turns a final transcript into a Route: send it as a prompt, answer or stop an
// agent, or switch tab / workspace. With Jev, one call answers every question
// in parallel against option lists built from herdr's live state; without it,
// a few exact phrases are recognised and everything else is a prompt.

import type { Route } from '../shared/types.ts';
import type { JevAnswers, JevQuestion } from './jev.ts';
import type { HerdrModel, PaneModel } from './model.ts';

const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'approve', 'approved', 'go', 'go ahead', 'do it', 'proceed', 'yes please', 'ship it']);
const NO = new Set(['no', 'nope', 'deny', 'denied', 'no thanks', 'dont', "don't", 'reject']);
const STOP = new Set(['stop', 'wait', 'hold on', 'cancel', 'abort']);

/** Below this probability a command is too unsure to act on, and the words go to the agent as a prompt. */
const MIN_ACTION_P = 0.5;

const POINT_FIRST = 'Point at an agent, then pinch and hold to talk';

function agentsOf(model: HerdrModel): PaneModel[] {
  return model.panes.filter((p) => p.agent && p.cells.w > 0);
}

function pointedAgent(model: HerdrModel, paneId: string | null): PaneModel | null {
  return agentsOf(model).find((p) => p.id === paneId) ?? null;
}

/** Without Jev: exact yes / no / stop to the pointed agent, anything else is a prompt to it. */
export function localRoute(text: string, paneId: string | null, model: HerdrModel): Route {
  const pane = pointedAgent(model, paneId);
  if (!pane) return { kind: 'none', reason: POINT_FIRST };
  const word = text.toLowerCase().replace(/[^a-z' ]/g, '').trim();
  if (pane.state === 'blocked' && YES.has(word)) return { kind: 'approve', paneId: pane.id };
  if (pane.state === 'blocked' && NO.has(word)) return { kind: 'deny', paneId: pane.id };
  if (STOP.has(word)) return { kind: 'interrupt', paneId: pane.id };
  return { kind: 'prompt', paneId: pane.id };
}

export interface RoutePlan {
  questions: Record<string, JevQuestion>;
  state: Record<string, unknown>;
  /** Option keys ("p1", "t3", …) back to herdr ids. */
  panes: Map<string, string>;
  tabs: Map<string, string>;
  workspaces: Map<string, string>;
  pointed: string | null;
}

const STATE_TEXT: Record<string, string> = {
  blocked: 'waiting for permission',
  working: 'working',
  idle: 'idle',
  done: 'finished',
  unknown: 'status unknown',
};

export function planRoute(text: string, paneId: string | null, model: HerdrModel): RoutePlan {
  const agents = agentsOf(model);
  const pointed = pointedAgent(model, paneId);
  const wsLabel = new Map(model.workspaces.map((w) => [w.id, w.label]));
  const questions: Record<string, JevQuestion> = {};
  const panes = new Map<string, string>();
  const tabs = new Map<string, string>();
  const workspaces = new Map<string, string>();

  const action: Record<string, string> = {
    prompt: 'Anything meant for a coding agent to read: a task, instruction, question or remark. This is the default.',
  };
  const answerable = pointed ? pointed.state === 'blocked' : agents.some((p) => p.state === 'blocked');
  if (answerable) {
    action.approve = 'Only a short yes / go ahead / approve, answering an agent that is waiting for permission.';
    action.deny = 'Only a short no / reject / don\'t, answering an agent that is waiting for permission.';
  }
  if (agents.length > 0) {
    action.stop =
      'Only a bare order to halt an agent right now, like "stop", "stop codex", "hold on", "abort". A sentence asking the agent to stop doing something in its work ("stop mocking the database") is a prompt.';
  }
  const names = (labels: string[]) => [...new Set(labels)].slice(0, 60).map((l) => `"${l}"`).join(', ');
  if (model.tabs.length > 1) {
    action.focus_tab = `Asks to switch to, go to, open or show a tab, or just names one. The tabs are ${names(model.tabs.map((t) => t.label))}.`;
  }
  if (model.workspaces.length > 1) {
    action.focus_workspace = `Asks to switch to, go to or open a workspace (project), or just names one. The workspaces are ${names(model.workspaces.map((w) => w.label))}.`;
  }
  questions.action = {
    type: 'choice',
    instructions: 'The user is controlling a terminal full of coding agents by voice. What do they want to do with what they said?',
    criteria: action,
  };

  if (!pointed && agents.length > 1) {
    const criteria: Record<string, string> = {};
    agents.forEach((p, i) => {
      panes.set(`p${i + 1}`, p.id);
      criteria[`p${i + 1}`] = `"${p.label}": a ${p.agent} agent, ${STATE_TEXT[p.state] ?? p.state}`;
    });
    questions.target = {
      type: 'choice',
      instructions: 'Which coding agent is the user talking to? Match a name they say (the agent kind like "codex" or "claude", or its folder). If they name none, prefer the one waiting for permission.',
      criteria,
    };
  }
  if (model.tabs.length > 1) {
    const criteria: Record<string, string> = {};
    model.tabs.slice(0, 200).forEach((t, i) => {
      tabs.set(`t${i + 1}`, t.id);
      criteria[`t${i + 1}`] = `tab "${t.label}" (tab ${t.number} in workspace "${wsLabel.get(t.workspaceId) ?? t.workspaceId}")`;
    });
    questions.tab = { type: 'choice', instructions: 'If the user wants to switch tabs, which tab do they mean?', criteria };
  }
  if (model.workspaces.length > 1) {
    const criteria: Record<string, string> = {};
    model.workspaces.slice(0, 200).forEach((w, i) => {
      workspaces.set(`w${i + 1}`, w.id);
      criteria[`w${i + 1}`] = `workspace "${w.label}" (workspace ${w.number})`;
    });
    questions.workspace = { type: 'choice', instructions: 'If the user wants to switch workspaces, which workspace do they mean?', criteria };
  }

  const focusedTab = model.tabs.find((t) => t.focused);
  const state = {
    user_said: text,
    pointing_at: pointed ? `"${pointed.label}", ${STATE_TEXT[pointed.state] ?? pointed.state}` : 'nothing',
    current_workspace: model.workspaces.find((w) => w.focused)?.label ?? null,
    current_tab: focusedTab?.label ?? null,
  };
  return { questions, state, panes, tabs, workspaces, pointed: pointed?.id ?? null };
}

/** True when there is more than the default action to decide, so a Jev call is worth making. */
export function worthAsking(plan: RoutePlan): boolean {
  const q = plan.questions.action;
  return (q?.type === 'choice' && Object.keys(q.criteria).length > 1) || plan.questions.target !== undefined;
}

function pick(answers: JevAnswers, key: string, ids: Map<string, string>): string | null {
  const a = answers[key];
  return a?.type === 'choice' ? (ids.get(a.choice) ?? null) : null;
}

export function interpretRoute(plan: RoutePlan, answers: JevAnswers, model: HerdrModel): Route {
  const agents = agentsOf(model);
  const a = answers.action;
  let action = a?.type === 'choice' ? a.choice : 'prompt';
  const p = (k: string) => (a?.type === 'choice' ? (a.probabilities?.[k] ?? (a.choice === k ? (a.confidence ?? 0) : 0)) : 0);
  // A name that is both a tab and a workspace splits the vote between them; together they still mean "navigate".
  const sure = action === 'focus_tab' || action === 'focus_workspace' ? p('focus_tab') + p('focus_workspace') : p(action);
  if (action !== 'prompt' && sure < MIN_ACTION_P) action = 'prompt';

  if (action === 'focus_tab') {
    const id = pick(answers, 'tab', plan.tabs);
    const tab = model.tabs.find((t) => t.id === id);
    return tab ? { kind: 'focusTab', tabId: tab.id, label: tab.label } : { kind: 'none', reason: "Couldn't tell which tab" };
  }
  if (action === 'focus_workspace') {
    const id = pick(answers, 'workspace', plan.workspaces);
    const ws = model.workspaces.find((w) => w.id === id);
    return ws ? { kind: 'focusWorkspace', workspaceId: ws.id, label: ws.label } : { kind: 'none', reason: "Couldn't tell which workspace" };
  }

  const targetId = plan.pointed ?? (agents.length === 1 ? agents[0].id : pick(answers, 'target', plan.panes));
  const target = agents.find((p) => p.id === targetId);
  if (!target) return { kind: 'none', reason: agents.length ? POINT_FIRST : 'No agents in this tab' };
  if ((action === 'approve' || action === 'deny') && target.state === 'blocked') return { kind: action, paneId: target.id };
  if (action === 'stop') return { kind: 'interrupt', paneId: target.id };
  return { kind: 'prompt', paneId: target.id };
}
