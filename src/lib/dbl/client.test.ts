import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DblClient } from './client';

vi.mock('../../env', () => ({
  default: {
    DBL_API_BASE_URL: 'https://rest.api.bible/v1',
    DBL_API_KEY: 'test-key',
  },
}));

describe('dblClient', () => {
  let client: DblClient;

  beforeEach(() => {
    client = new DblClient();

    // Disable sleep to speed up retry tests
    vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches bibles and validates response', async () => {
    const mockResponse = {
      data: [
        {
          id: '123',
          dblId: '123',
          abbreviation: 'KJV',
          abbreviationLocal: 'KJV',
          language: {
            id: 'eng',
            name: 'English',
            nameLocal: 'English',
            script: 'Latn',
            scriptDirection: 'LTR',
          },
          name: 'King James Version',
          nameLocal: 'King James Version',
          type: 'text',
          updatedAt: '2023-01-01T00:00:00Z',
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const bibles = await client.getBibles();
    expect(bibles.length).toBe(1);
    expect(bibles[0].abbreviation).toBe('KJV');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://rest.api.bible/v1/bibles',
      expect.objectContaining({
        headers: { 'api-key': 'test-key', 'Content-Type': 'application/json' },
      })
    );
  });

  it('retries on rate limit (429) using exponential backoff', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' })
      .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: '123',
              dblId: '123',
              abbreviation: 'KJV',
              name: 'KJV',
              nameLocal: 'KJV',
              type: 'text',
              updatedAt: '2023-01-01',
              language: {
                id: 'eng',
                name: 'English',
                nameLocal: 'English',
                script: 'Latn',
                scriptDirection: 'LTR',
              },
            },
          ],
        }),
      });

    const bibles = await client.getBibles();
    expect(bibles.length).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect((client as any).sleep).toHaveBeenCalledTimes(2);
  });

  it('throws error if retries are exhausted', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });

    await expect(client.getBibles()).rejects.toThrow('DBL API error: 500 Server Error');
    expect(globalThis.fetch).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('does NOT retry non-retryable client errors (e.g. 404)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

    await expect(client.getBibles()).rejects.toThrow('DBL API error: 404 Not Found');
    // Should throw immediately without any retries
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect((client as any).sleep).not.toHaveBeenCalled();
  });
});
