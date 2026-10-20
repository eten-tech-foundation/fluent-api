import { createHash } from 'node:crypto';

import type { BriefingEvent } from './assistant.client';
import type { AssistantLanguage } from './assistant.config';
import type { PassageContext } from './assistant.repository';

import { SUGGESTED_QUESTION_MACRO, WIDGET_CONTRACT_VERSION } from './assistant.prompt';

interface BriefingCacheIdentityInput {
  operationVersion: string;
  profileVersion: string;
  resourcePolicyVersion: string;
  cacheEpoch: string;
  maxOutputBytes: number;
  language: AssistantLanguage;
  resourceLanguage: string;
  groundingInstruction: string;
  passage: PassageContext;
}

/** Fixed-shape serialization: every field is answer-affecting and property order is deliberate. */
export function serializeBriefingCacheIdentity(input: BriefingCacheIdentityInput): string {
  return JSON.stringify({
    operation: 'passage_briefing',
    operationVersion: input.operationVersion,
    profileVersion: input.profileVersion,
    resourcePolicyVersion: input.resourcePolicyVersion,
    cacheEpoch: input.cacheEpoch,
    outputValidation: { maxBytes: input.maxOutputBytes },
    outputContractVersion: WIDGET_CONTRACT_VERSION,
    widgetInventory: [{ type: 'suggested_question', count: 3, grammar: SUGGESTED_QUESTION_MACRO }],
    responseLanguageHint: input.language.responseLanguageHint,
    guidanceSlug: input.language.guidanceSlug ?? 'default',
    grounding: {
      resourceLanguage: input.resourceLanguage,
      instruction: input.groundingInstruction,
    },
    source: {
      bible: input.passage.sourceBible,
      languageCode: input.passage.sourceLanguageCode,
      verses: input.passage.verses.map(({ bookCode, chapter, verse, text }) => ({
        reference: { bookCode, chapter, verse },
        text,
      })),
    },
  });
}

export function briefingCacheKey(input: BriefingCacheIdentityInput): string {
  return createHash('sha256').update(serializeBriefingCacheIdentity(input)).digest('hex');
}

/** A passage-briefing producer that retains all normalized events for late same-process joiners. */
export class RetainedBriefingProducer {
  private readonly events: BriefingEvent[] = [];
  private readonly upstreamController = new AbortController();
  private terminal = false;
  private completionWrite = false;
  private production: Promise<void> | undefined;
  private changed: Promise<void>;
  private notify!: () => void;

  constructor() {
    this.changed = new Promise((resolve) => {
      this.notify = resolve;
    });
  }

  get upstreamSignal(): AbortSignal {
    return this.upstreamController.signal;
  }

  publish(event: BriefingEvent): boolean {
    if (this.terminal) return false;
    // The client accepts empty progress frames, but retaining them would allow unbounded array
    // overhead without consuming the upstream output-byte budget.
    if (event.type === 'briefing_delta' && event.delta.length === 0) return true;
    this.events.push(event);
    this.terminal = event.type === 'briefing_complete' || event.type === 'briefing_error';
    const notify = this.notify;
    this.changed = new Promise((resolve) => {
      this.notify = resolve;
    });
    notify();
    return true;
  }

  beginCompletionWrite(): void {
    this.completionWrite = true;
  }

  /** Publishes before leaving the write critical section; shutdown cannot interleave the two. */
  finishCompletionWrite(event: BriefingEvent): boolean {
    const published = this.publish(event);
    this.completionWrite = false;
    return published;
  }

  attachProduction(production: Promise<void>): void {
    this.production = production;
  }

  async shutdown(): Promise<void> {
    this.upstreamController.abort();
    if (!this.completionWrite)
      this.publish({ type: 'briefing_error', code: 'temporarily_unavailable', retryable: true });
    await this.production;
  }

  async *subscribe(signal?: AbortSignal): AsyncGenerator<BriefingEvent> {
    let position = 0;
    while (!signal?.aborted) {
      while (position < this.events.length) {
        if (signal?.aborted) return;
        yield this.events[position++];
      }
      if (this.terminal) return;
      if (!(await this.waitForChange(signal))) return;
    }
  }

  private async waitForChange(signal?: AbortSignal): Promise<boolean> {
    if (!signal) {
      await this.changed;
      return true;
    }
    if (signal.aborted) return false;
    let onAbort!: () => void;
    const aborted = new Promise<false>((resolve) => {
      onAbort = () => resolve(false);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([this.changed.then(() => true as const), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

interface StreamingEntry {
  producer: RetainedBriefingProducer;
  removeAfterLookups: boolean;
}

const streaming = new Map<string, StreamingEntry>();
const cacheLookups = new Map<string, number>();
let acceptingProducers = true;

export function findInFlightBriefing(cacheKey: string): RetainedBriefingProducer | undefined {
  return streaming.get(cacheKey)?.producer;
}

/**
 * Keeps a completed retained producer visible while a database miss that began before its commit
 * is still outstanding. Releasing the lease cannot race install-or-join because callers do both
 * synchronously after the read.
 */
export function beginBriefingCacheLookup(cacheKey: string): () => void {
  cacheLookups.set(cacheKey, (cacheLookups.get(cacheKey) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (cacheLookups.get(cacheKey) ?? 1) - 1;
    if (remaining > 0) {
      cacheLookups.set(cacheKey, remaining);
      return;
    }
    cacheLookups.delete(cacheKey);
    const entry = streaming.get(cacheKey);
    if (entry?.removeAfterLookups) streaming.delete(cacheKey);
  };
}

/** No await may separate this check and install. */
export function installOrJoinBriefing(cacheKey: string): {
  producer: RetainedBriefingProducer;
  installed: boolean;
} {
  const existing = streaming.get(cacheKey);
  if (existing) return { producer: existing.producer, installed: false };
  const producer = new RetainedBriefingProducer();
  if (!acceptingProducers) {
    void producer.shutdown();
    return { producer, installed: false };
  }
  streaming.set(cacheKey, { producer, removeAfterLookups: false });
  return { producer, installed: true };
}

export function removeInFlightBriefing(cacheKey: string, producer: RetainedBriefingProducer): void {
  const entry = streaming.get(cacheKey);
  if (entry?.producer !== producer) return;
  if ((cacheLookups.get(cacheKey) ?? 0) > 0) entry.removeAfterLookups = true;
  else streaming.delete(cacheKey);
}

/** Abort upstream work, settle retained terminals, and reject installs during shutdown. */
export async function shutdownInFlightBriefings(): Promise<void> {
  acceptingProducers = false;
  const producers = [...streaming.values()].map(({ producer }) => producer);
  await Promise.all(producers.map((producer) => producer.shutdown()));
  streaming.clear();
  cacheLookups.clear();
}

export function resetInFlightBriefingsForTests(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('test helper used outside tests');
  for (const { producer } of streaming.values()) void producer.shutdown();
  streaming.clear();
  cacheLookups.clear();
  acceptingProducers = true;
}
