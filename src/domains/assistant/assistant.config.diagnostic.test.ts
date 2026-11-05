import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assistantLanguageConfigurationFailure,
  validateAssistantLanguages,
} from './assistant.config';

const state = vi.hoisted(() => ({ raw: '', warn: vi.fn() }));
vi.mock('@/env', () => ({
  default: {
    get ASSISTANT_LANGUAGES_JSON() {
      return state.raw;
    },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: state.warn } }));

afterEach(() => {
  state.raw = '';
});

describe('sanitized language diagnostics', () => {
  it('returns a non-retryable public code and logs a fixed reason only once', () => {
    state.raw = '{secret-credential';
    expect(assistantLanguageConfigurationFailure()).toEqual({
      code: 'invalid_configuration',
      retryable: false,
    });
    assistantLanguageConfigurationFailure();
    expect(state.warn).toHaveBeenCalledExactlyOnceWith(
      { reason: 'The value must be valid JSON.' },
      'Invalid ASSISTANT_LANGUAGES_JSON configuration'
    );
    expect(JSON.stringify(state.warn.mock.calls)).not.toContain('secret-credential');
  });

  it('distinguishes unwired configuration from malformed configured languages', () => {
    expect(assistantLanguageConfigurationFailure()).toBeNull();
    state.raw = '{}';
    expect(assistantLanguageConfigurationFailure()?.code).toBe('invalid_configuration');
  });

  it('explains schema and cross-entry failures without emitting arbitrary input', () => {
    const report = vi.fn();
    validateAssistantLanguages({ privateInput: 'secret-value' }, report);
    expect(report).toHaveBeenLastCalledWith(
      'Language schema validation failed: language entry (invalid_type). Check required fields, types, and size limits.'
    );
    validateAssistantLanguages({}, report);
    expect(report).toHaveBeenLastCalledWith('The English fallback entry en is required.');
    expect(JSON.stringify(report.mock.calls)).not.toContain('secret-value');
  });
});
