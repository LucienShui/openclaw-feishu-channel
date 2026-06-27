// Feishu plugin module implements in-flight reply cancellation.
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";

type FeishuReplyFenceState = {
  generation: number;
  activeDispatches: number;
  abortControllers?: Set<AbortController>;
};

type FeishuReplyFenceContext = {
  Body?: string;
  RawBody?: string;
  CommandBody?: string;
  CommandAuthorized?: boolean;
  SessionKey?: string;
  CommandTargetSessionKey?: string;
};

const feishuReplyFenceByKey = new Map<string, FeishuReplyFenceState>();

function normalizeFenceKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolveFeishuReplyFenceKey(ctx: FeishuReplyFenceContext): string | undefined {
  return normalizeFenceKey(ctx.CommandTargetSessionKey) ?? normalizeFenceKey(ctx.SessionKey);
}

function shouldSupersedeFeishuReplyFence(ctx: FeishuReplyFenceContext): boolean {
  const text = ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
  return ctx.CommandAuthorized === true && isAbortRequestText(text);
}

function abortFeishuReplyFenceControllers(state: FeishuReplyFenceState): void {
  for (const controller of state.abortControllers ?? []) {
    controller.abort();
  }
  state.abortControllers?.clear();
}

function maybeDeleteFeishuReplyFenceState(key: string, state: FeishuReplyFenceState): void {
  if (state.activeDispatches <= 0 && (state.abortControllers?.size ?? 0) === 0) {
    feishuReplyFenceByKey.delete(key);
    return;
  }
  feishuReplyFenceByKey.set(key, state);
}

function beginFeishuReplyFence(params: {
  key?: string;
  supersede: boolean;
  abortController: AbortController;
  log?: (message: string) => void;
}): number | undefined {
  if (!params.key) {
    return undefined;
  }
  const state = feishuReplyFenceByKey.get(params.key) ?? {
    generation: 0,
    activeDispatches: 0,
  };
  if (params.supersede) {
    state.generation += 1;
    params.log?.(`feishu: /stop superseding active reply work for session=${params.key}`);
    abortFeishuReplyFenceControllers(state);
  }
  (state.abortControllers ??= new Set()).add(params.abortController);
  state.activeDispatches += 1;
  feishuReplyFenceByKey.set(params.key, state);
  return state.generation;
}

function endFeishuReplyFence(key: string | undefined, abortController: AbortController): void {
  if (!key) {
    return;
  }
  const state = feishuReplyFenceByKey.get(key);
  if (!state) {
    return;
  }
  state.abortControllers?.delete(abortController);
  state.activeDispatches = Math.max(0, state.activeDispatches - 1);
  maybeDeleteFeishuReplyFenceState(key, state);
}

function isFeishuReplyFenceSuperseded(params: {
  key?: string;
  generation?: number;
}): boolean {
  if (!params.key || params.generation === undefined) {
    return false;
  }
  return (feishuReplyFenceByKey.get(params.key)?.generation ?? 0) !== params.generation;
}

export function createFeishuReplyFenceGuard(
  ctx: FeishuReplyFenceContext,
  log?: (message: string) => void,
): {
  abortSignal: AbortSignal;
  isSuperseded: () => boolean;
  end: () => void;
} {
  const key = resolveFeishuReplyFenceKey(ctx);
  const abortController = new AbortController();
  const generation = beginFeishuReplyFence({
    key,
    supersede: shouldSupersedeFeishuReplyFence(ctx),
    abortController,
    log,
  });
  let ended = false;
  return {
    abortSignal: abortController.signal,
    isSuperseded: () =>
      abortController.signal.aborted || isFeishuReplyFenceSuperseded({ key, generation }),
    end: () => {
      if (ended) {
        return;
      }
      ended = true;
      endFeishuReplyFence(key, abortController);
    },
  };
}

export function resetFeishuReplyFenceForTests(): void {
  feishuReplyFenceByKey.clear();
}
