/* The Logistics rows an account can feed, picked on the Chart of Accounts (owner
   2026-10-29: the own-lorry tick list 「就不能在coa 那边tick？」 →「可以」). Pinned:
     • the list, each row's label as the picker shows it, and the account type it reads;
     • the outsource and income rows' regions, none for the in-house rows;
     • our lorries' cost (the cost report's per-trip) = Petrol + Upkeep + Other lorry cost. */

import { describe, expect, test } from 'vitest';
import { LOGISTICS_ROWS, isLogisticsRow, logisticsRowLabel, logisticsRowType, ownLorryAccounts, regionOfRow } from './logistics-rows';

describe('the Logistics rows', () => {
  test('each row its label and the account type it reads', () => {
    expect(LOGISTICS_ROWS.map((r) => [r, logisticsRowLabel(r), logisticsRowType(r)])).toEqual([
      ['outsource_pg', 'Outsource – Penang', 'EXPENSE'],
      ['outsource_kl', 'Outsource – KL', 'EXPENSE'],
      ['outsource_em', 'Outsource – SBH & SWK', 'EXPENSE'],
      ['outsource_sg', 'Outsource – SGD', 'EXPENSE'],
      ['petrol', 'Petrol', 'EXPENSE'],
      ['upkeep', 'Upkeep', 'EXPENSE'],
      ['other_lorry', 'Other lorry cost', 'EXPENSE'],
      ['instalment', 'Lorry Installment', 'LIABILITY'],
      ['roadtax', 'RoadTax & Insurance', 'EXPENSE'],
      ['income_pg', 'Transport Income – Penang', 'INCOME'],
      ['income_kl', 'Transport Income – KL', 'INCOME'],
      ['income_em', 'Transport Income – SBH & SWK', 'INCOME'],
      ['income_sg', 'Transport Income – SGD', 'INCOME'],
    ]);
    expect(isLogisticsRow('petrol')).toBe(true);
    expect(isLogisticsRow('manpower')).toBe(false);
    expect(isLogisticsRow(null)).toBe(false);
  });

  test('regions for the outsource and income rows only', () => {
    expect(regionOfRow('outsource_em')).toBe('EM');
    expect(regionOfRow('income_sg')).toBe('SG');
    expect(regionOfRow('petrol')).toBeNull();
    expect(regionOfRow('instalment')).toBeNull();
  });

  test("our lorries' cost: the accounts on Petrol, Upkeep and Other lorry cost — not instalment, road tax or outsource", () => {
    const chart = [
      { account_code: '900-P015', account_name: 'PETROL, TOL AND PARKING - LORI VRH 9058', account_type: 'EXPENSE', logistics_row: 'petrol' },
      { account_code: '900-U010', account_name: 'UPKEEP OF LORI - VPC 9058', account_type: 'EXPENSE', logistics_row: 'upkeep' },
      { account_code: '900-G001', account_name: 'LORRY GPS', account_type: 'EXPENSE', logistics_row: 'other_lorry' },
      { account_code: '900-I002', account_name: 'INSURANCE & ROAD TAX', account_type: 'EXPENSE', logistics_row: 'roadtax' },
      { account_code: '450-H002', account_name: 'HP CREDITOR- VNB 9058', account_type: 'LIABILITY', logistics_row: 'instalment' },
      { account_code: '900-T006', account_name: 'TRANSPORT (KL, SLG, MLK, JHR, OTHERS)', account_type: 'EXPENSE', logistics_row: 'outsource_kl' },
      { account_code: '900-P008', account_name: 'PETROL, TOL AND PARKING - DIRECTOR & OTHERS', account_type: 'EXPENSE', logistics_row: null },
    ];
    expect(ownLorryAccounts(chart)).toEqual(['900-G001', '900-P015', '900-U010']);
  });
});
