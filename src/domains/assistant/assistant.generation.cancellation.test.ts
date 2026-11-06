import { beforeEach, expect, it, vi } from 'vitest';

import type { BtClientFactory, MockBtInstance } from './assistant.route.test-fixtures';

import {
  assistantRouteMocks,
  authenticate,
  post,
  resetAssistantRouteTestFixture,
  user,
  validBody,
} from './assistant.route.test-fixtures';

beforeEach(async () => {
  await resetAssistantRouteTestFixture();
  authenticate();
});

function assertAvailable() {
  const release = assistantRouteMocks.acquireGeneration(user.id);
  expect(release).toBeTypeOf('function');
  release?.();
}

it('releases a private briefing when its iterator closes immediately after started', async () => {
  const { createPassageBriefing } = await import('./assistant.service');
  const controller = new AbortController();
  const result = await createPassageBriefing({
    projectId: 7,
    userId: user.id,
    body: { ...validBody, ignore_cache: true },
    signal: controller.signal,
    logger: assistantRouteMocks.logger,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  try {
    expect((await result.data.events.next()).value?.type).toBe('briefing_started');
    expect(assistantRouteMocks.acquireGeneration(user.id)).toBeNull();
    await result.data.events.return(undefined);
    expect(controller.signal.aborted).toBe(false);
    assertAvailable();
  } finally {
    controller.abort();
  }
});

it('aborts private upstream work and frees admission when the response reader cancels', async () => {
  let upstream: AbortSignal | undefined;
  vi.mocked(assistantRouteMocks.BtServantClient).mockImplementation(function (
    this: MockBtInstance
  ) {
    this.stream = vi.fn(async function* (_request: unknown, signal: AbortSignal) {
      upstream = signal;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
    });
  } as unknown as BtClientFactory);
  const response = await post({ ...validBody, ignore_cache: true });
  const reader = response.body!.getReader();
  await reader.read();
  await vi.waitFor(() => expect(upstream).toBeDefined());
  expect(assistantRouteMocks.acquireGeneration(user.id)).toBeNull();
  await reader.cancel();
  await vi.waitFor(() => expect(upstream?.aborted).toBe(true));
  assertAvailable();
});

it('keeps shared upstream admission after response cancellation until production settles', async () => {
  let upstream: AbortSignal | undefined;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.mocked(assistantRouteMocks.BtServantClient).mockImplementation(function (
    this: MockBtInstance
  ) {
    this.stream = vi.fn(async function* (_request: unknown, signal: AbortSignal) {
      upstream = signal;
      await gate;
      yield { type: 'briefing_delta', delta: 'answer' };
      yield { type: 'briefing_complete', markdown: 'answer' };
    });
  } as unknown as BtClientFactory);
  try {
    const response = await post(validBody);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(upstream?.aborted).toBe(false);
    expect(assistantRouteMocks.acquireGeneration(user.id)).toBeNull();
  } finally {
    finish();
  }
  await vi.waitFor(assertAvailable);
});

it('releases a private turn when its iterator closes immediately after started', async () => {
  const { readFileSync } = await import('node:fs');
  const { createPassageTurn } = await import('./assistant.turn.service');
  const receiptModule = await import('./assistant.receipts');
  const contextModule = await import('./assistant.context');
  const { assistantTurnRequestSchema, turnContextSchema } = await import('./assistant.turn.types');
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/turn-v1.json', import.meta.url), 'utf8')
  );
  const context = turnContextSchema.parse(fixture.context);
  const key = receiptModule.parseReceiptKey({
    ASSISTANT_RECEIPT_KEY_ID: 'test',
    ASSISTANT_RECEIPT_KEY_HEX: '02'.repeat(32),
  })!;
  const keySpy = vi.spyOn(receiptModule, 'loadReceiptKey').mockReturnValue(key);
  const contextSpy = vi.spyOn(contextModule, 'resolveTurnContext').mockReturnValue(context);
  const receipts = new receiptModule.TurnReceipts(key, user.id, context);
  const body = assistantTurnRequestSchema.parse(fixture.request);
  body.contextReceipt = receipts.contextReceipt();
  body.briefing.receipt = receipts.prefix(receipts.briefingBinding(), body.briefing);
  const controller = new AbortController();
  try {
    const result = await createPassageTurn({
      projectId: context.projectId,
      userId: user.id,
      body,
      signal: controller.signal,
      logger: assistantRouteMocks.logger,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await result.data.events.next()).value?.type).toBe('turn_started');
    expect(assistantRouteMocks.acquireGeneration(user.id)).toBeNull();
    await result.data.events.return(undefined);
    expect(controller.signal.aborted).toBe(false);
    assertAvailable();
  } finally {
    controller.abort();
    keySpy.mockRestore();
    contextSpy.mockRestore();
  }
});
