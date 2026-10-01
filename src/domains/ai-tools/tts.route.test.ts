import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import { fetchTtsAudio, generateTtsAudio } from './tts.service';

import '@/domains/ai-tools/tts.route';

/**
 * Route-level tests for the Source-TTS proxy (proposal §12.2).
 *
 * SCOPE NOTE: the upstream service is mocked here, so these tests prove what
 * fluent-api does with what fluent-ai says — authorization, the length tripwire,
 * verbatim passthrough, and status/header relay. They deliberately do NOT prove
 * `redirect: 'manual'`, which is a property of the fetch call inside
 * tts.service.ts; that is asserted against a mocked `fetch` in tts.service.test.ts.
 * Splitting it that way keeps each guarantee tested where it actually lives.
 */

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => {
  const mockQueryBuilder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ activeOrgId: 1 }]),
  };
  return {
    db: { select: vi.fn(() => mockQueryBuilder), insert: vi.fn(), update: vi.fn() },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/domains/users/users.service', () => ({
  getUserByEmail: vi.fn(),
}));

vi.mock('@/domains/user-roles/user-roles.repository', () => ({
  findGrantsByUserId: vi.fn(),
}));

vi.mock('./tts.service', () => ({
  generateTtsAudio: vi.fn(),
  fetchTtsAudio: vi.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const APP_USER = {
  id: 1,
  email: 'translator@example.com',
  role: 5,
  roleName: 'translator',
  organization: 1,
  status: 'verified' as const,
};

const HASH = '9f2ac1d47bfe3a5c8e1d0b6a4f7c2e91';
const AUDIO_FILE = `${HASH}.wav`;
const VALID_BODY = { text: 'In the beginning God created the heavens and the earth.' };

/**
 * Authenticate as APP_USER, holding TTS_USE or holding nothing.
 *
 * `requirePermission(TTS_USE)` is called without a scope resolver, so it reduces to
 * `user.grants.some((g) => g.permissions.has(TTS_USE))` (`role-auth.ts`). The grant's
 * org/project ids are therefore not consulted on this route and are only present
 * because the row shape requires them.
 */
function asAuthenticatedUser(granted: boolean) {
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: APP_USER.email },
  });
  (getUserByEmail as any).mockResolvedValue(ok(APP_USER));
  (findGrantsByUserId as any).mockResolvedValue(
    ok(granted ? [{ orgId: 1, projectId: 1, permissions: new Set([PERMISSIONS.TTS_USE]) }] : [])
  );
}

function postGenerate(body: unknown) {
  return server.request('/ai/tts/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function requestAudio(file: string, method: 'GET' | 'HEAD' = 'GET') {
  return server.request(`/ai/tts/audio/${file}`, { method });
}

/** An upstream fluent-ai response for fetchTtsAudio to hand back. */
function upstreamOk(
  status: number,
  headers: Record<string, string> = {},
  body: BodyInit | null = null
) {
  (fetchTtsAudio as any).mockResolvedValue({
    ok: true,
    data: new Response(body, { status, headers }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Authorization (T13 / §11.1) ───────────────────────────────────────────────

describe('tTS proxy authorization', () => {
  it('returns 401 on generate when unauthenticated', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);

    const res = await postGenerate(VALID_BODY);

    expect(res.status).toBe(401);
    expect(generateTtsAudio).not.toHaveBeenCalled();
  });

  it('returns 401 on get-audio when unauthenticated', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);

    const res = await requestAudio(AUDIO_FILE);

    expect(res.status).toBe(401);
    expect(fetchTtsAudio).not.toHaveBeenCalled();
  });

  it('returns 403 on generate without TTS_USE', async () => {
    asAuthenticatedUser(false);

    const res = await postGenerate(VALID_BODY);

    expect(res.status).toBe(403);
    expect(generateTtsAudio).not.toHaveBeenCalled();
  });

  it('returns 403 on get-audio without TTS_USE', async () => {
    asAuthenticatedUser(false);

    const res = await requestAudio(AUDIO_FILE);

    expect(res.status).toBe(403);
    expect(fetchTtsAudio).not.toHaveBeenCalled();
  });

  it('gates on a VIEW-level permission, not an edit-level one', async () => {
    // Pins the T13 decision: "hearing follows seeing". If TTS_USE is ever
    // repointed at an edit permission, a reviewer with legitimate read access to
    // the passage would silently lose audio — so the alias target is asserted.
    expect(PERMISSIONS.TTS_USE).toBe('project:view');

    // Post-RBAC the check is a set membership test on the user's grants, so the
    // alias is pinned by admitting a grant that holds TTS_USE and nothing else.
    (auth.api.getSession as any).mockResolvedValue({
      session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
      user: { email: APP_USER.email },
    });
    (getUserByEmail as any).mockResolvedValue(ok(APP_USER));
    (findGrantsByUserId as any).mockResolvedValue(
      ok([{ orgId: 1, projectId: 1, permissions: new Set([PERMISSIONS.TTS_USE]) }])
    );
    (generateTtsAudio as any).mockResolvedValue({ ok: true, data: { audio_url: 'x' } });

    const res = await postGenerate(VALID_BODY);

    expect(res.status).toBe(200);
    expect(findGrantsByUserId).toHaveBeenCalledWith(APP_USER.id);
  });
});

// ─── POST /ai/tts/generate ─────────────────────────────────────────────────────

describe('pOST /ai/tts/generate', () => {
  it('passes the response body through unmodified, including unknown fields', async () => {
    asAuthenticatedUser(true);
    // The extra key stands in for a field a future fluent-ai adds. The response
    // schema is `.passthrough()` so it must survive the proxy; a `.strict()` or
    // default-stripping schema would silently eat it.
    const upstream = {
      audio_url: 'audio/9f2ac1d47bfe3a5c8e1d0b6a4f7c2e91.wav',
      someFutureField: { nested: true },
    };
    (generateTtsAudio as any).mockResolvedValue({ ok: true, data: upstream });

    const res = await postGenerate(VALID_BODY);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(upstream);
  });

  it('never rewrites the sibling-relative audio_url into an absolute URL', async () => {
    asAuthenticatedUser(true);
    const relative = 'audio/9f2ac1d47bfe3a5c8e1d0b6a4f7c2e91.wav';
    (generateTtsAudio as any).mockResolvedValue({ ok: true, data: { audio_url: relative } });

    const res = await postGenerate(VALID_BODY);
    const json = (await res.json()) as { audio_url: string };

    // Byte-identical: the browser resolves this against the URL it called, so any
    // "helpful" absolutizing here breaks resolution (§7.1).
    expect(json.audio_url).toBe(relative);
  });

  it('forwards the validated request to the service without enrichment (T6)', async () => {
    asAuthenticatedUser(true);
    (generateTtsAudio as any).mockResolvedValue({ ok: true, data: { audio_url: 'a.wav' } });
    const body = { text: 'hello', voice: 'en-US-Standard-A', lang_code: 'eng' };

    await postGenerate(body);

    expect(generateTtsAudio).toHaveBeenCalledOnce();
    expect(generateTtsAudio).toHaveBeenCalledWith(body);
  });

  it('leaves an omitted format omitted so fluent-ai resolves its own default', async () => {
    asAuthenticatedUser(true);
    (generateTtsAudio as any).mockResolvedValue({ ok: true, data: { audio_url: 'a.wav' } });

    await postGenerate({ text: 'hello' });

    // Injecting a default here would change the upstream content hash and split
    // the cache between clients that send a format and clients that do not.
    const [forwarded] = (generateTtsAudio as any).mock.calls[0];
    expect('format' in forwarded).toBe(false);
  });

  it('does not judge text length — a long body is forwarded, not rejected (T27)', async () => {
    asAuthenticatedUser(true);
    (generateTtsAudio as any).mockResolvedValue({ ok: true, data: { audio_url: 'a.wav' } });

    // Far beyond fluent-ai's default 20k tripwire. This proxy must still forward
    // it: fluent-ai owns the limit and holds the only copy of the number, so a
    // cap here would be a second value that has to agree with the first.
    const text = 'a'.repeat(50_000);
    const res = await postGenerate({ text });

    expect(res.status).toBe(200);
    const [forwarded] = (generateTtsAudio as any).mock.calls[0];
    expect(forwarded.text).toHaveLength(50_000);
  });

  it('rejects empty text as an invalid request, distinctly from too-long', async () => {
    asAuthenticatedUser(true);

    const res = await postGenerate({ text: '' });

    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.code).toBe('TTS_INVALID_REQUEST');
    expect(generateTtsAudio).not.toHaveBeenCalled();
  });

  it('rejects unknown fields (strict request schema)', async () => {
    asAuthenticatedUser(true);

    const res = await postGenerate({ text: 'hello', verseId: 42 });

    // A caller sending verse identity is a bug worth surfacing: TTS is
    // deliberately backend-agnostic and carries no scripture identity (T6).
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'TTS_INVALID_REQUEST' });
    expect(generateTtsAudio).not.toHaveBeenCalled();
  });

  it('returns 502 when fluent-ai is unreachable', async () => {
    asAuthenticatedUser(true);
    (generateTtsAudio as any).mockResolvedValue({
      ok: false,
      error: { code: ErrorCode.AI_SERVICE_UNAVAILABLE, message: 'fluent-ai unreachable' },
    });

    const res = await postGenerate(VALID_BODY);

    // 502, never 503: a 503 from this feature means fluent-ai's admission gate
    // refused, and fluent-api must not counterfeit that signal.
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      code: ErrorCode.AI_SERVICE_UNAVAILABLE,
    });
  });
});

// ─── GET|HEAD /ai/tts/audio/{file} ─────────────────────────────────────────────

describe('gET /ai/tts/audio/{file}', () => {
  it('relays a 302 with Location intact and does not follow it', async () => {
    asAuthenticatedUser(true);
    const target = 'https://audio.example.org/tts/9f2ac1d47bfe3a5c8e1d0b6a4f7c2e91.ogg';
    upstreamOk(302, { location: target });

    const res = await requestAudio(AUDIO_FILE);

    // The most breakable behaviour in this phase. If the relay ever resolves the
    // redirect itself, this becomes a 200 and immutable audio starts two-hopping
    // through fluent-api instead of being served straight from public storage.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(target);
    expect(fetchTtsAudio).toHaveBeenCalledOnce();
  });

  it('relays a 200 audio stream with its content type', async () => {
    asAuthenticatedUser(true);
    upstreamOk(200, { 'content-type': 'audio/wav' }, 'RIFFfake-wav-bytes');

    const res = await requestAudio(AUDIO_FILE);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    await expect(res.text()).resolves.toBe('RIFFfake-wav-bytes');
  });

  it('relays a 503 with Retry-After so the client can wait out admission control', async () => {
    asAuthenticatedUser(true);
    upstreamOk(503, { 'retry-after': '5' });

    const res = await requestAudio(AUDIO_FILE);

    // Dropping Retry-After would leave the client guessing when to retry a
    // generation that fluent-ai's RAM gate refused.
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('relays a 404 so the client can self-heal by re-calling generate', async () => {
    asAuthenticatedUser(true);
    upstreamOk(404);

    const res = await requestAudio(AUDIO_FILE);

    expect(res.status).toBe(404);
  });

  it('returns 502 when fluent-ai is unreachable', async () => {
    asAuthenticatedUser(true);
    (fetchTtsAudio as any).mockResolvedValue({
      ok: false,
      error: { code: ErrorCode.AI_SERVICE_UNAVAILABLE, message: 'fluent-ai unreachable' },
    });

    const res = await requestAudio(AUDIO_FILE);

    expect(res.status).toBe(502);
  });

  it('splits {hash}.{ext} and forwards both parts, preserving the requested era', async () => {
    asAuthenticatedUser(true);
    upstreamOk(200, { 'content-type': 'audio/ogg' });

    await requestAudio(`${HASH}.ogg`);

    expect(fetchTtsAudio).toHaveBeenCalledWith(
      HASH,
      'ogg',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('drops hop-by-hop headers instead of copying upstream headers wholesale', async () => {
    asAuthenticatedUser(true);
    upstreamOk(200, {
      'content-type': 'audio/wav',
      'transfer-encoding': 'chunked',
      server: 'fluent-ai-test',
    });

    const res = await requestAudio(AUDIO_FILE);

    // These describe the upstream connection, not this one; re-emitting them can
    // corrupt the response or leak upstream identity.
    expect(res.headers.get('transfer-encoding')).toBeNull();
    expect(res.headers.get('server')).toBeNull();
    expect(res.headers.get('content-type')).toBe('audio/wav');
  });

  it.each([
    ['path traversal', '../../secrets.wav'],
    ['non-hex hash', 'zzzz.wav'],
    ['unsupported extension', `${HASH}.exe`],
    ['no extension', HASH],
  ])('rejects a malformed audio filename (%s) without calling upstream', async (_label, file) => {
    asAuthenticatedUser(true);

    const res = await requestAudio(file);

    // Either the router never matches it (404) or the param schema rejects it
    // (400) — what matters is that nothing reaches fluent-ai.
    expect([400, 404]).toContain(res.status);
    expect(fetchTtsAudio).not.toHaveBeenCalled();
  });
});

describe('audio streaming', () => {
  it('delivers the first chunk before the upstream body has finished', async () => {
    asAuthenticatedUser(true);

    // The upstream stream emits one chunk, then STALLS until this gate opens —
    // standing in for synthesis still in progress.
    let releaseSecondChunk!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('chunk-1'));
        await gate;
        controller.enqueue(encoder.encode('chunk-2'));
        controller.close();
      },
    });
    (fetchTtsAudio as any).mockResolvedValue({
      ok: true,
      data: new Response(body, { status: 200, headers: { 'content-type': 'audio/wav' } }),
    });

    const res = await requestAudio(AUDIO_FILE);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Readable while the upstream stream is still open. Had the relay buffered
    // (`await upstream.arrayBuffer()` / `.text()`), this line could not be reached
    // at all — the request would hang until the gate opened, so a regression here
    // fails as a timeout rather than passing quietly. This is what makes first
    // audio start before synthesis finishes.
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('chunk-1');

    releaseSecondChunk();
    const second = await reader.read();
    expect(decoder.decode(second.value)).toBe('chunk-2');

    await reader.cancel();
  });
});

describe('hEAD /ai/tts/audio/{file}', () => {
  it('answers with status and headers but no body', async () => {
    asAuthenticatedUser(true);
    upstreamOk(200, { 'content-type': 'audio/wav', 'content-length': '1024' });

    const res = await requestAudio(AUDIO_FILE, 'HEAD');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    await expect(res.text()).resolves.toBe('');
  });

  it('forwards the method as HEAD rather than fetching the whole body', async () => {
    asAuthenticatedUser(true);
    upstreamOk(200, { 'content-type': 'audio/wav' });

    await requestAudio(AUDIO_FILE, 'HEAD');

    expect(fetchTtsAudio).toHaveBeenCalledWith(
      HASH,
      'wav',
      expect.objectContaining({ method: 'HEAD' })
    );
  });

  it('relays a 302 so the client can detect the compressed era', async () => {
    asAuthenticatedUser(true);
    const target = 'https://audio.example.org/tts/x.ogg';
    upstreamOk(302, { location: target });

    const res = await requestAudio(AUDIO_FILE, 'HEAD');

    // fluent-web's probeClipUrl branches on exactly this.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(target);
  });

  it('relays a 503 with Retry-After', async () => {
    asAuthenticatedUser(true);
    upstreamOk(503, { 'retry-after': '7' });

    const res = await requestAudio(AUDIO_FILE, 'HEAD');

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('7');
  });
});
