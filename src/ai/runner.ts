/**
 * TaskRunner: runs AI tasks as observable, persistent state machines.
 *
 * One loop serves every mode: the model streams text and tool calls; tool calls are executed by a
 * ToolHost (provided by the coding agent for plan/build, read-only for ask); results go back to the
 * model until it answers without tools or a limit is reached. Every step shown to the user
 * corresponds to something that actually happened. The runner never exposes private reasoning.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_BUDGETS,
  DEFAULT_TOKEN_SAVER,
  EDITING_MODES,
  EMPTY_USAGE,
  JOB_INFO,
  type Budgets,
  type Job,
  type TaskAttachment,
  type TaskContext,
  type TaskMessage,
  type TaskMode,
  type TaskStep,
  type TaskUpdate,
  type TaskView,
  type TokenSaver,
  type UsageTotals,
} from '../shared/ai';
import type { LiveEventKind, LivePhase, LiveTarget } from '../shared/live';
import { describeTool } from '../live/describe';
import { READ_FULL_OUTPUT_SPEC, STUB_MIN, compactToolOutput, estimateTokens, fullOutputNote, historyStub, maxOutputFor, nextHistoryBoundary, replyRules, sliceFullOutput } from './compact';
import { ProviderError } from './errors';
import { capabilityState } from './service';
import { redactor } from './redact';
import type { AiService, ResolvedRoute } from './service';
import { TaskStore } from './tasks';
import type { ChatMessage, ContentPart, ToolCall, ToolSpec } from './types';

export interface ToolResult {
  ok: boolean;
  /** Text returned to the model. */
  output: string;
  /** One line shown to the user. */
  summary: string;
  filesChanged?: string[];
  /** What the tool changed, for the live activity layer (changed lines of a file…). */
  targets?: import('../shared/live').LiveTarget[];
  /** A model call the tool made itself (visual inspection), added to the task's usage. */
  usage?: { input: number | null; output: number | null; cost: number | null };
}

/** Thrown by a tool host when an action needs the user's explicit permission. */
export class ApprovalRequired extends Error {
  constructor(readonly request: { id: string; title: string; detail: string }) {
    super(request.title);
    this.name = 'ApprovalRequired';
  }
}

export interface ToolHost {
  specs(): ToolSpec[];
  /** Allow one specific action the user approved. */
  grant?(approvalId: string): void;
  /** Short user-facing description of a call before it runs, e.g. “Read index.html”. */
  describe(call: ToolCall): string;
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
  /** Stop child processes and release resources. */
  dispose(): Promise<void>;
}

export interface CreateTaskInput {
  projectId: string;
  mode: TaskMode;
  prompt: string;
  context: TaskContext;
  attachments: TaskAttachment[];
  title?: string;
  job?: Job;
  /** Set by the coding agent: the version the task edits and what it may do. */
  workingLineId?: string;
  workingLineName?: string;
  originLineId?: string;
  permissions?: TaskView['permissions'];
  checkpointId?: string | null;
}

export interface RunnerDeps {
  ai: AiService;
  storeFor(projectId: string): Promise<TaskStore>;
  emit(projectId: string, taskId: string, update: TaskUpdate): void;
  /** Builds user content (selection, attached files) for the first message. */
  buildContext(task: TaskView): Promise<{ parts: ContentPart[]; system: string }>;
  /** Tool host for a task, or null when the mode has no tools. */
  toolsFor(task: TaskView): Promise<ToolHost | null>;
  /** Called once when a task ends, so the agent can sync changes or summarise results. */
  onFinished?(task: TaskView): Promise<void>;
  /** Live activity events (pointer, highlight, activity pill). */
  live?(event: import('../shared/live').LiveEvent): void;
  /** Full text of shortened tool results, kept so the model can read it again. */
  outputs?: { save(task: TaskView, ref: string, text: string): Promise<void>; read(task: TaskView, ref: string): Promise<string | null> };
}

interface Active {
  task: TaskView;
  controller: AbortController;
  steer: string[];
  paused: boolean;
  pauseReason?: string | null;
  resume: (() => void) | null;
  decide: ((approve: boolean) => void) | null;
  done: Promise<void>;
}

const now = (): string => new Date().toISOString();

function message(role: TaskMessage['role'], text: string, extra: Partial<TaskMessage> = {}): TaskMessage {
  return { id: `msg-${randomUUID().slice(0, 12)}`, role, text, toolCalls: [], toolResult: null, createdAt: now(), partial: false, ...extra };
}

function addUsage(total: UsageTotals, input: number | null, output: number | null, cost: number | null, extra: { cached?: number | null; saved?: number } = {}): UsageTotals {
  const known = input !== null || output !== null;
  return {
    requests: total.requests + 1,
    inputTokens: known ? (total.inputTokens ?? 0) + (input ?? 0) : total.inputTokens,
    outputTokens: known ? (total.outputTokens ?? 0) + (output ?? 0) : total.outputTokens,
    cachedInputTokens: extra.cached !== undefined && extra.cached !== null ? (total.cachedInputTokens ?? 0) + extra.cached : (total.cachedInputTokens ?? null),
    savedTokensEstimate: (total.savedTokensEstimate ?? 0) + (extra.saved ?? 0),
    estimatedCostUsd: cost !== null ? (total.estimatedCostUsd ?? 0) + cost : total.estimatedCostUsd,
    partial: total.partial || cost === null,
  };
}

export class TaskRunner {
  private readonly active = new Map<string, Active>();

  constructor(private readonly deps: RunnerDeps) {}

  get activeCount(): number {
    return this.active.size;
  }

  isRunning(taskId: string): boolean {
    return this.active.has(taskId);
  }

  async create(input: CreateTaskInput): Promise<TaskView> {
    const prompt = redactor.redact(input.prompt.trim());
    if (!prompt) throw new ProviderError('bad-request', 'Describe what you want to create or change.');
    const job: Job = input.job ?? (input.mode === 'ask' ? 'assistant' : 'coding');
    const created = now();
    const task: TaskView = {
      id: `task-${randomUUID()}`,
      projectId: input.projectId,
      title: input.title ?? (prompt.length > 80 ? `${prompt.slice(0, 77)}…` : prompt),
      mode: input.mode,
      job,
      state: 'queued',
      createdAt: created,
      updatedAt: created,
      route: null,
      usage: { ...EMPTY_USAGE },
      error: null,
      context: input.context,
      attachments: input.attachments,
      messages: [message('user', prompt)],
      steps: [],
      plan: null,
      filesChanged: [],
      result: null,
      workingLineId: input.workingLineId ?? input.context.lineId,
      workingLineName: input.workingLineName ?? input.context.lineName,
      originLineId: input.originLineId ?? input.context.lineId,
      permissions: input.permissions,
      checkpointId: input.checkpointId ?? null,
      approval: null,
      artifacts: [],
    };
    await this.persist(task);
    this.start(task);
    return task;
  }

  /** Add a message: steer a running task, or continue a finished one. */
  async send(projectId: string, taskId: string, text: string): Promise<TaskView> {
    const clean = redactor.redact(text.trim());
    if (!clean) throw new ProviderError('bad-request', 'The message is empty.');
    const active = this.active.get(taskId);
    if (active) {
      active.steer.push(clean);
      active.task.messages.push(message('user', clean));
      if (active.paused) this.resume(taskId);
      await this.persist(active.task);
      return active.task;
    }
    const store = await this.deps.storeFor(projectId);
    const task = await store.get(taskId);
    if (!task) throw new ProviderError('not-found', 'That task no longer exists.');
    task.messages.push(message('user', clean));
    task.state = 'queued';
    task.error = null;
    task.result = null;
    await this.persist(task);
    this.start(task);
    return task;
  }

  async cancel(projectId: string, taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) {
      const store = await this.deps.storeFor(projectId);
      const task = await store.get(taskId);
      if (task && (task.state === 'queued' || task.state === 'waiting-input' || task.state === 'paused')) {
        task.state = 'cancelled';
        await this.persist(task);
      }
      return;
    }
    active.task.state = 'cancelling';
    await this.persist(active.task);
    active.controller.abort();
    active.resume?.();
    active.decide?.(false);
    await active.done;
  }

  /** Answer a pending approval request. */
  async decide(taskId: string, approve: boolean): Promise<void> {
    const active = this.active.get(taskId);
    if (!active?.decide) throw new ProviderError('bad-request', 'This task is not waiting for a decision.');
    active.decide(approve);
  }

  private async askApproval(active: Active, request: { id: string; title: string; detail: string }): Promise<boolean> {
    const step = this.step(active.task, 'note', 'Waiting for your permission', request.title);
    step.status = 'waiting';
    active.task.state = 'waiting-input';
    active.task.approval = request;
    await this.persist(active.task);
    const approved = await new Promise<boolean>((resolve) => {
      active.decide = resolve;
    });
    active.decide = null;
    active.task.approval = null;
    this.finishStep(step, active.controller.signal.aborted ? 'cancelled' : 'done', approved ? `Allowed: ${request.title}` : `Declined: ${request.title}`);
    if (!active.controller.signal.aborted) active.task.state = 'running';
    await this.persist(active.task);
    return approved;
  }

  /** Pause before the next action. `reason` explains it (for example, the user started editing the same thing). */
  pause(taskId: string, reason?: string): void {
    const active = this.active.get(taskId);
    if (!active || active.paused) return;
    active.paused = true;
    active.pauseReason = reason === 'user-edit' ? 'Paused while you edit. It continues when you stop editing.' : (reason ?? null);
    // The pause takes effect at the next step boundary; say so instead of claiming it already stopped.
    this.live(active.task, 'operation.progress', { phase: 'waiting', description: reason === 'user-edit' ? 'Pausing while you edit' : 'Pausing after this step' });
  }

  resume(taskId: string): void {
    const active = this.active.get(taskId);
    if (!active) return;
    active.paused = false;
    active.pauseReason = null;
    active.resume?.();
    active.resume = null;
  }

  /** Cancel every running task (used when the app or a project closes). */
  async cancelAll(projectId?: string): Promise<void> {
    await Promise.all([...this.active.values()].filter((a) => !projectId || a.task.projectId === projectId).map((a) => this.cancel(a.task.projectId, a.task.id)));
  }

  private start(task: TaskView): void {
    const controller = new AbortController();
    const active: Active = { task, controller, steer: [], paused: false, resume: null, decide: null, done: Promise.resolve() };
    this.active.set(task.id, active);
    active.done = this.run(active).finally(() => this.active.delete(task.id));
  }

  private async persist(task: TaskView): Promise<void> {
    task.updatedAt = now();
    const store = await this.deps.storeFor(task.projectId);
    await store.save(task);
    this.deps.emit(task.projectId, task.id, { kind: 'snapshot', task: structuredClone(task) });
  }

  private step(task: TaskView, kind: TaskStep['kind'], title: string, detail = ''): TaskStep {
    const step: TaskStep = { id: `step-${randomUUID().slice(0, 10)}`, kind, title: redactor.redact(title), status: 'running', detail: redactor.redact(detail), startedAt: now(), endedAt: null };
    task.steps.push(step);
    return step;
  }

  private finishStep(step: TaskStep, status: TaskStep['status'], detail?: string): void {
    step.status = status;
    step.endedAt = now();
    if (detail !== undefined) step.detail = redactor.redact(detail);
  }

  /**
   * Convert stored messages to the provider-neutral conversation. Tool results before
   * `task.compactedBefore` are sent shortened (when history compaction is on); `saved` counts the
   * characters kept out of this request by compaction.
   */
  private conversation(task: TaskView, firstUserParts: ContentPart[], structured = false, shortenHistory = false): { messages: ChatMessage[]; saved: number; toolChars: number } {
    const out: ChatMessage[] = [];
    let firstUser = true;
    let saved = 0;
    let toolChars = 0;
    const boundary = shortenHistory ? (task.compactedBefore ?? 0) : 0;
    for (const [index, m] of task.messages.entries()) {
      if (m.partial) continue;
      if (m.role === 'tool' && m.toolResult) {
        const r = m.toolResult;
        const content = index < boundary && r.output.length > STUB_MIN ? historyStub(r.name, r.callId, r.output) : r.output;
        saved += Math.max(0, (r.fullChars ?? r.output.length) - content.length);
        toolChars += content.length;
        if (structured) out.push({ role: 'user', content: [{ type: 'text', text: `Result of ${r.name} (${r.ok ? 'ok' : 'failed'}):\n${content}` }] });
        else out.push({ role: 'tool', toolCallId: r.callId, name: r.name, content, isError: !r.ok });
        continue;
      }
      if (m.role === 'user') {
        out.push({ role: 'user', content: firstUser ? [...firstUserParts, { type: 'text', text: m.text }] : [{ type: 'text', text: m.text }] });
        firstUser = false;
      } else if (m.role === 'assistant') {
        out.push({ role: 'assistant', text: m.text, toolCalls: structured ? [] : m.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })) });
      }
    }
    return { messages: out, saved, toolChars };
  }

  /** The full text of an earlier (shortened) tool result of this task. */
  private async readFullOutput(task: TaskView, raw: unknown): Promise<ToolResult> {
    const a = (raw ?? {}) as { ref?: unknown; start_line?: unknown; end_line?: unknown; find?: unknown };
    const ref = typeof a.ref === 'string' ? a.ref : '';
    const stored = task.messages.find((m) => m.toolResult?.callId === ref)?.toolResult ?? null;
    if (!ref || !stored) return { ok: false, output: `No earlier result has the ref “${ref}”. Use the ref given in a shortened result.`, summary: 'Unknown ref' };
    const text = (await this.deps.outputs?.read(task, ref).catch(() => null)) ?? stored.output;
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);
    return { ok: true, output: sliceFullOutput(text, { start_line: num(a.start_line), end_line: num(a.end_line), find: typeof a.find === 'string' && a.find ? a.find : undefined }), summary: `Read the full ${stored.name} result` };
  }

  /** One live activity event for a task (see src/shared/live.ts). */
  private live(task: TaskView, kind: LiveEventKind, p: { phase: LivePhase; description: string; operationId?: string | null; operation?: string | null; target?: LiveTarget | null; resourceId?: string | null; scope?: number; progress?: number | null; detail?: string | null }): void {
    if (!this.deps.live) return;
    this.deps.live({
      kind,
      taskId: `task:${task.id}`,
      taskLabel: task.title,
      actor: 'ai-task',
      operationId: p.operationId ?? null,
      projectId: task.projectId,
      universeId: task.workingLineId ?? task.context.lineId ?? null,
      universeName: task.workingLineName ?? task.context.lineName ?? null,
      resourceId: p.resourceId ?? null,
      target: p.target ?? null,
      scope: p.scope ?? 1,
      operation: p.operation ?? null,
      phase: p.phase,
      at: new Date().toISOString(),
      description: p.description,
      progress: p.progress ?? null,
      pointer: false,
      action: null,
      canPause: true,
      detail: p.detail ?? null,
    });
  }

  private async waitIfPaused(active: Active): Promise<void> {
    if (!active.paused) return;
    const reason = active.pauseReason ?? 'Waiting for you to resume.';
    const step = this.step(active.task, 'note', 'Paused', reason);
    step.status = 'waiting';
    active.task.state = 'paused';
    this.live(active.task, 'task.paused', { phase: 'paused', description: active.pauseReason?.startsWith('Paused while you edit') ? 'Paused while you edit' : 'Paused', detail: reason });
    await this.persist(active.task);
    await new Promise<void>((resolve) => {
      active.resume = resolve;
    });
    this.finishStep(step, active.controller.signal.aborted ? 'cancelled' : 'done', 'Resumed.');
    if (!active.controller.signal.aborted) {
      active.task.state = 'running';
      this.live(active.task, 'task.resumed', { phase: 'planning', description: 'Resumed' });
    }
  }

  private async run(active: Active): Promise<void> {
    const { task, controller } = active;
    const signal = controller.signal;
    let tools: ToolHost | null = null;
    let route: ResolvedRoute | null = null;
    const settings = await this.deps.ai.store.read().catch(() => null);
    const budgets: Budgets = settings?.budgets ?? DEFAULT_BUDGETS;
    const saver: TokenSaver = settings?.tokenSaver ?? DEFAULT_TOKEN_SAVER;
    const deadline = Date.now() + budgets.maxMinutes * 60_000;
    const timer = setTimeout(() => controller.abort(new Error('time-limit')), Math.max(1, deadline - Date.now()));
    let limitReason: string | null = null;
    try {
      task.state = 'running';
      task.error = null;
      this.live(task, 'task.started', { phase: 'planning', description: task.mode === 'ask' || task.mode === 'plan' ? 'Looking into your question' : 'Starting the task' });
      route = await this.deps.ai.resolve(task.job);
      task.route = { connectionId: route.connection.id, connectionName: route.connection.name, modelId: route.model.id, local: route.local };
      await this.persist(task);

      const built = await this.deps.buildContext(task);
      const parts = built.parts;
      let system = built.system;
      const style = replyRules(saver.replies);
      if (style) system += `\n${style}`;
      tools = await this.deps.toolsFor(task);
      const specs = [...(tools?.specs() ?? [])];
      // Shortened results can be read again in full.
      if (specs.length && (saver.compactOutputs || saver.compactHistory)) specs.push(READ_FULL_OUTPUT_SPEC);
      const toolsChars = JSON.stringify(specs).length;
      const maxOutputTokens = maxOutputFor(saver.replies, EDITING_MODES.includes(task.mode));
      let iterations = 0;
      // Models without native tool calling use a strictly validated structured-command protocol,
      // and only when they can produce structured output. Commands are read after a reply is complete.
      const structured = specs.length > 0 && capabilityState(route.model, 'tools') === 'unavailable';
      let invalidInARow = 0;
      if (structured) {
        if (capabilityState(route.model, 'structured-output') === 'unavailable') {
          throw new ProviderError('unsupported', `${route.model.label} has neither tool calling nor structured output, so it can’t operate the studio. Use Ask mode, or assign a model with tool calling to the Director or Coding role.`);
        }
        system += `\n\n${structuredProtocol(specs)}`;
        this.step(task, 'note', 'Structured commands', `${route.model.label} has no native tool calling. Each complete reply may contain one JSON command, which is validated before anything runs.`).status = 'done';
      }

      for (;;) {
        await this.waitIfPaused(active);
        if (signal.aborted) break;
        active.steer.length = 0; // steering messages are already in task.messages
        const modelStep = this.step(task, 'model', `Asked ${route.model.label}`, route.local ? 'Runs on this computer.' : `Sent to ${route.connection.name}.`);
        const reply = message('assistant', '', { partial: true });
        task.messages.push(reply);
        await this.persist(task);

        const calls: ToolCall[] = [];
        let lastFlush = Date.now();
        let pending = '';
        let input: number | null = null;
        let output: number | null = null;
        const flush = (): void => {
          if (!pending) return;
          this.deps.emit(task.projectId, task.id, { kind: 'delta', messageId: reply.id, text: pending });
          pending = '';
        };
        // Shorten older results in batches only, so the start of the request stays identical between batches.
        if (saver.compactHistory) {
          const next = nextHistoryBoundary(
            task.messages.map((m) => ({ role: m.role, output: m.toolResult?.output ?? null, hasToolCalls: m.toolCalls.length > 0 })),
            task.compactedBefore ?? 0,
          );
          if (next !== (task.compactedBefore ?? 0)) task.compactedBefore = next;
        }
        const convo = this.conversation(task, parts, structured, saver.compactHistory);
        const convoChars = convo.messages.reduce((n, m) => n + (m.role === 'user' ? m.content.reduce((k, p) => k + (p.type === 'text' ? p.text.length : 0), 0) : m.role === 'assistant' ? m.text.length + JSON.stringify(m.toolCalls).length : 0), 0);
        task.lastRequest = { instructions: estimateTokens(system.length), tools: structured ? 0 : estimateTokens(toolsChars), conversation: estimateTokens(convoChars), toolResults: estimateTokens(convo.toolChars), saved: estimateTokens(convo.saved) };
        let cached: number | null = null;
        this.live(task, 'operation.started', { phase: 'planning', description: 'Planning the next step', operationId: modelStep.id, operation: 'model' });
        for await (const ev of this.deps.ai.generate(route, { system, messages: convo.messages, tools: specs.length && !structured ? specs : undefined, maxOutputTokens, cache: saver.promptCaching ? { key: `mv-${task.id.slice(-24)}` } : null }, signal)) {
          if (ev.type === 'text') {
            reply.text += ev.delta;
            pending += ev.delta;
            if (Date.now() - lastFlush > 40) {
              flush();
              lastFlush = Date.now();
            }
          } else if (ev.type === 'tool-call') calls.push(ev.call);
          else if (ev.type === 'usage') {
            input = ev.inputTokens;
            output = ev.outputTokens;
            cached = ev.cachedInputTokens ?? null;
          }
        }
        flush();
        reply.partial = false;
        let retryInvalid = false;
        if (structured) {
          const parsed = parseStructuredCommand(reply.text, specs);
          if (parsed.kind === 'call') {
            calls.push(parsed.call);
            invalidInARow = 0;
          } else if (parsed.kind === 'none') {
            invalidInARow = 0;
          } else {
            retryInvalid = true;
            invalidInARow += 1;
            task.messages.push(message('tool', 'Command not run', { toolResult: { callId: `invalid-${randomUUID().slice(0, 8)}`, name: 'structured-command', ok: false, output: `Your command was not run: ${parsed.reason} Reply with exactly one valid json block, or answer in plain text without one.` } }));
            this.step(task, 'note', 'Command not run', parsed.reason).status = 'failed';
            if (invalidInARow >= 2) {
              limitReason = `${route.model.label} did not produce a valid command twice in a row, so it can’t reliably operate the studio. Assign a model with tool calling to the Director or Coding role.`;
            }
          }
        }
        reply.toolCalls = calls.map((c) => ({ id: c.id, name: c.name, args: c.args }));
        const cost = this.deps.ai.estimateCost(route.model, input, output);
        task.usage = addUsage(task.usage, input, output, cost, { cached, saved: estimateTokens(convo.saved) });
        this.finishStep(modelStep, 'done', input !== null || output !== null ? `${input ?? '?'} input${cached ? ` (${cached} from cache)` : ''} · ${output ?? '?'} output tokens` : 'The provider did not report token usage.');
        await this.persist(task);

        if (limitReason) break;
        if (retryInvalid) continue;
        if (budgets.perTaskUsd !== null && task.usage.estimatedCostUsd !== null && task.usage.estimatedCostUsd > budgets.perTaskUsd) {
          limitReason = `Stopped: the estimated cost ($${task.usage.estimatedCostUsd.toFixed(4)}) passed this task’s budget of $${budgets.perTaskUsd.toFixed(2)}.`;
          break;
        }
        if (calls.length === 0 || !tools) {
          if (calls.length && !tools) {
            this.step(task, 'note', 'Ignored tool calls', 'This mode has no tools, so the requested actions were not run.').status = 'done';
          }
          break;
        }
        for (const call of calls) {
          if (signal.aborted) break;
          await this.waitIfPaused(active);
          const toolStep = this.step(task, call.name === 'run_command' || call.name === 'run_tests' || call.name === 'start_dev_server' ? 'command' : 'tool', call.name === READ_FULL_OUTPUT_SPEC.name ? 'Read an earlier result in full' : tools.describe(call));
          const toolLive = describeTool(call.name, (call.args ?? {}) as Record<string, unknown>);
          // Studio commands report their own targets from the command engine.
          const liveTool = call.name !== 'run_studio_command';
          if (liveTool) this.live(task, 'operation.started', { ...toolLive, operationId: toolStep.id, operation: call.name, resourceId: typeof (call.args as { path?: unknown })?.path === 'string' ? (call.args as { path: string }).path : null });
          await this.persist(task);
          let result: ToolResult;
          try {
            result =
              call.rawArgs !== undefined
                ? { ok: false, output: 'The arguments were not valid JSON. Send a JSON object.', summary: 'Invalid arguments' }
                : call.name === READ_FULL_OUTPUT_SPEC.name
                  ? await this.readFullOutput(task, call.args)
                  : await tools.execute(call, signal);
          } catch (error) {
            if (error instanceof ApprovalRequired) {
              const approved = await this.askApproval(active, error.request);
              if (approved && !signal.aborted) {
                tools.grant?.(error.request.id);
                try {
                  result = await tools.execute(call, signal);
                } catch (inner) {
                  result = { ok: false, output: redactor.redact((inner as Error).message), summary: redactor.redact((inner as Error).message) };
                }
              } else {
                result = { ok: false, output: `The user declined: ${error.request.title}. Do not retry it; continue without it or explain what is needed.`, summary: `Declined: ${error.request.title}` };
              }
            } else {
              result = { ok: false, output: redactor.redact((error as Error).message), summary: redactor.redact((error as Error).message) };
            }
          }
          for (const f of result.filesChanged ?? []) if (!task.filesChanged.includes(f)) task.filesChanged.push(f);
          if (result.usage) task.usage = addUsage(task.usage, result.usage.input, result.usage.output, result.usage.cost);
          const full = redactor.redact(result.output);
          let sent = compactToolOutput(call.name, full, saver.compactOutputs);
          if (saver.compactOutputs && sent !== full && this.deps.outputs) {
            // Keep the full text so the model (or the user) can read it again.
            const kept = await this.deps.outputs.save(task, call.id, full).then(
              () => true,
              () => false,
            );
            if (kept) sent += fullOutputNote(call.id, full.length, sent.length);
          }
          task.messages.push(message('tool', result.summary, { toolResult: { callId: call.id, name: call.name, ok: result.ok, output: sent.slice(0, 60_000), ...(sent !== full ? { fullChars: full.length } : {}) } }));
          this.finishStep(toolStep, signal.aborted ? 'cancelled' : result.ok ? 'done' : 'failed', result.summary);
          if (liveTool && !signal.aborted) {
            const target = result.targets?.[0] ?? null;
            this.live(task, result.ok ? 'operation.completed' : 'operation.failed', { ...toolLive, description: result.ok ? toolLive.description : result.summary, operationId: toolStep.id, operation: call.name, target, scope: result.targets?.length ?? result.filesChanged?.length ?? 1, resourceId: target?.kind === 'code' ? target.path : null, detail: result.ok ? result.summary : result.summary });
          }
          await this.persist(task);
        }
        if (signal.aborted) break;
        iterations += 1;
        if (iterations >= budgets.maxToolIterations) {
          limitReason = `Stopped after ${iterations} rounds of actions (the limit in Settings → Usage and budgets).`;
          break;
        }
      }

      if (signal.aborted) {
        const timedOut = signal.reason instanceof Error && signal.reason.message === 'time-limit';
        task.state = timedOut ? 'failed' : 'cancelled';
        if (timedOut) task.error = { kind: 'limit', message: `Stopped after ${budgets.maxMinutes} minutes (the time limit in Settings).` };
      } else if (limitReason) {
        task.state = 'failed';
        task.error = { kind: 'limit', message: limitReason };
      } else {
        task.state = 'completed';
        const last = [...task.messages].reverse().find((m) => m.role === 'assistant' && m.text.trim());
        task.result = { summary: last?.text.trim().slice(0, 4000) ?? 'Finished without a written answer.', problems: [] };
      }
    } catch (error) {
      if (signal.aborted || (error instanceof ProviderError && error.kind === 'cancelled')) {
        const timedOut = signal.reason instanceof Error && signal.reason.message === 'time-limit';
        task.state = timedOut ? 'failed' : 'cancelled';
        if (timedOut) task.error = { kind: 'limit', message: `Stopped after ${budgets.maxMinutes} minutes (the time limit in Settings).` };
      } else if (error instanceof ProviderError) {
        task.state = 'failed';
        task.error = { kind: error.kind, message: redactor.redact(`${error.message}${error.kind === 'not-configured' || error.kind === 'unsupported' ? '' : ` ${error.help}`}`) };
      } else {
        task.state = 'failed';
        task.error = { kind: 'internal', message: redactor.redact((error as Error).message) };
      }
    } finally {
      clearTimeout(timer);
      for (const m of task.messages) if (m.partial) m.partial = false;
      task.approval = null;
      for (const s of task.steps) if (s.status === 'running' || s.status === 'waiting') this.finishStep(s, task.state === 'cancelled' ? 'cancelled' : 'failed');
      if (task.state === 'cancelled') this.step(task, 'note', 'Cancelled', 'Stopped at your request.').status = 'done';
      const changed = task.filesChanged.length;
      if (task.state === 'completed') this.live(task, 'task.completed', { phase: 'completed', description: changed ? `Done · ${changed} file${changed === 1 ? '' : 's'} changed` : 'Done', detail: task.result?.summary ?? null });
      else if (task.state === 'cancelled') this.live(task, 'task.cancelled', { phase: 'cancelled', description: 'Stopped', detail: changed ? `${changed} changed file${changed === 1 ? ' is' : 's are'} kept in ${task.workingLineName ?? 'its universe'}.` : 'Nothing was changed.' });
      else this.live(task, 'task.failed', { phase: 'failed', description: 'Task failed', detail: task.error?.message ?? null });
      await tools?.dispose().catch(() => undefined);
      await this.deps.onFinished?.(task).catch(() => undefined);
      await this.persist(task).catch(() => undefined);
    }
  }
}

export { JOB_INFO };

/** Instructions for models without native tool calling. */
export function structuredProtocol(specs: ToolSpec[]): string {
  return [
    'Tools: this model has no native tool calling. To use a tool, end your reply with exactly one fenced block:',
    '```json',
    '{"tool": "<tool name>", "args": { … }}',
    '```',
    'Write nothing after the block. The result comes back in the next message. Use one tool per reply. When you are done, answer in plain text with no json block.',
    'Available tools (arguments as JSON Schema):',
    ...specs.map((s) => `- ${s.name}: ${s.description} Arguments: ${JSON.stringify(s.parameters)}`),
  ].join('\n');
}

/**
 * Read a structured command from a complete reply. Exactly one ```json block holding
 * {"tool": string, "args": object} with a known tool name; anything else is not run.
 */
export function parseStructuredCommand(text: string, specs: ToolSpec[]): { kind: 'none' } | { kind: 'call'; call: ToolCall } | { kind: 'invalid'; reason: string } {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  const opened = (text.match(/```json/g) ?? []).length;
  if (opened === 0) return { kind: 'none' };
  if (opened !== blocks.length) return { kind: 'invalid', reason: 'The json block is not closed (the reply may have been cut off).' };
  if (blocks.length > 1) return { kind: 'invalid', reason: 'The reply has more than one json block; send one command at a time.' };
  let value: unknown;
  try {
    value = JSON.parse(blocks[0]![1]!);
  } catch (error) {
    return { kind: 'invalid', reason: `The json block is not valid JSON (${(error as Error).message}).` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid', reason: 'The command must be a JSON object.' };
  const o = value as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'tool' && k !== 'args');
  if (typeof o.tool !== 'string' || !o.args || typeof o.args !== 'object' || Array.isArray(o.args) || extra.length) return { kind: 'invalid', reason: 'The command must be {"tool": "<name>", "args": {…}} with no other keys.' };
  if (!specs.some((s) => s.name === o.tool)) return { kind: 'invalid', reason: `There is no tool named “${o.tool}”.` };
  return { kind: 'call', call: { id: `sc-${randomUUID().slice(0, 12)}`, name: o.tool, args: o.args } };
}
