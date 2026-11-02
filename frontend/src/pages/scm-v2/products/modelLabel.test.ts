import { describe, expect, test } from 'vitest';
import { modelFilterLabel, modelLabelOf } from './modelLabel';

// 2990-0022: base_model is the model CODE and is never renamed; the SKU Master
// shows and filters on the model's live name, falling back to the code.
describe('modelLabelOf', () => {
  test('uses the live model name over the base_model code', () => {
    expect(modelLabelOf({ base_model: '8210', model_name: 'TANNAH' })).toBe('TANNAH');
  });
  test('falls back to base_model when the SKU has no model name', () => {
    expect(modelLabelOf({ base_model: '8210', model_name: null })).toBe('8210');
    expect(modelLabelOf({ base_model: '8210' })).toBe('8210');
  });
  test('is empty when neither is set', () => {
    expect(modelLabelOf({ base_model: null, model_name: null })).toBe('');
  });
});

describe('modelFilterLabel', () => {
  test('adds the code in brackets so the dropdown still finds it by code', () => {
    expect(modelFilterLabel('TANNAH', '8210')).toBe('TANNAH (8210)');
  });
  test('shows the name alone when it already is the code or the code is unknown', () => {
    expect(modelFilterLabel('8210', '8210')).toBe('8210');
    expect(modelFilterLabel('TANNAH', null)).toBe('TANNAH');
  });
});
