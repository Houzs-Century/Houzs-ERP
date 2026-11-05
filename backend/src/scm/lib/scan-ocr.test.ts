// scan-ocr — the SO scan model setting, and the request fields each model accepts.
import { describe, expect, test } from 'vitest';
import { CLAUDE_MODEL, modelRequestFields, scanSoModel } from './scan-ocr';

describe('scanSoModel', () => {
  test('unset, blank or unknown falls back to the default model', () => {
    expect(scanSoModel({})).toBe(CLAUDE_MODEL);
    expect(scanSoModel({ SCAN_SO_MODEL: '  ' })).toBe(CLAUDE_MODEL);
    expect(scanSoModel({ SCAN_SO_MODEL: 'claude-opus-5-5' })).toBe(CLAUDE_MODEL);
  });
  test('a listed model is used, spaces trimmed', () => {
    expect(scanSoModel({ SCAN_SO_MODEL: ' claude-sonnet-5-5 ' })).toBe('claude-sonnet-5-5');
    expect(scanSoModel({ SCAN_SO_MODEL: 'claude-sonnet-4-6' })).toBe('claude-sonnet-4-6');
  });
});

describe('modelRequestFields', () => {
  test('Sonnet 4.6 keeps temperature 0 and sends no thinking field', () => {
    expect(modelRequestFields('claude-sonnet-4-6')).toEqual({ temperature: 0 });
  });
  test('Sonnet 5.5 sends no temperature and the lowest thinking setting', () => {
    expect(modelRequestFields('claude-sonnet-5-5')).toEqual({ thinking: { type: 'between_tools' } });
  });
});
