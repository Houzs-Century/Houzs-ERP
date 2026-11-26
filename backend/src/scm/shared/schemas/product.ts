
import { z } from 'zod';

const money = z.number().int().min(0).max(1_000_000);

const skuCode = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Z0-9-]+$/, 'SKU must be uppercase letters, digits, hyphens');

const includedAddon = z.object({
  addonId: z.string().min(1),
  qty:     z.number().int().min(1).max(20),
});

const productBase = z.object({
  sku:             skuCode,
  categoryId:      z.string().min(1),
  seriesId:        z.string().min(1).nullable(),
  name:            z.string().min(1).max(120),
  detail:          z.string().max(280).nullable(),
  sizeDisplay:     z.string().max(80).nullable(),
  depthOptions:    z.string().max(40).nullable(),
  imgKey:          z.string().max(200).nullable(),
  thumbKey:        z.string().max(200).nullable(),
  stock:           z.number().int().min(0),
  lowAt:           z.number().int().min(0),
  visible:         z.boolean(),
  includedAddons:  z.array(includedAddon).max(20).default([]),
});

const sofaPricingRow = z.object({
  compartmentId: z.string().min(1),
  active:        z.boolean(),
  price:         money,
});
const sofaBundleRow = z.object({
  bundleId: z.string().min(1),
  active:   z.boolean(),
  price:    money,
});
const sofaFabricRow = z.object({
  fabricId:  z.string().min(1),
  active:    z.boolean(),
  surcharge: money,
});

export const sofaProductSchema = productBase.extend({
  pricingKind:          z.literal('sofa_build'),
  reclinerUpgradePrice: money,
  seatUpgradeLabel:     z.string().max(40).nullable().optional(),
  seatUpgradeFootrest:  z.boolean().optional(),
  compartments:         z.array(sofaPricingRow).min(1),
  bundles:              z.array(sofaBundleRow),
  fabrics:              z.array(sofaFabricRow).min(1),
});

const sizeRow = z.object({
  sizeId: z.string().min(1),
  active: z.boolean(),
  price:  money,
});

export const sizeProductSchema = productBase.extend({
  pricingKind: z.literal('size_variants'),
  sizes:       z.array(sizeRow).min(1),
});

export const bedframeProductSchema = productBase.extend({
  pricingKind: z.literal('bedframe_build'),
  sizes:       z.array(sizeRow).min(1),
});

export const flatProductSchema = productBase.extend({
  pricingKind: z.literal('flat'),
  flatPrice:   money,
});

export const tbcProductSchema = productBase.extend({
  pricingKind: z.literal('tbc'),
});

export const productSchema = z.discriminatedUnion('pricingKind', [
  sofaProductSchema,
  sizeProductSchema,
  bedframeProductSchema,
  flatProductSchema,
  tbcProductSchema,
]).superRefine((val, ctx) => {
  if (val.pricingKind === 'size_variants' || val.pricingKind === 'bedframe_build') {
    const ok = val.sizes.some((s) => s.active && s.price > 0);
    if (!ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sizes'],
        message: 'Activate at least one size and fill in its price.',
      });
    }
  } else if (val.pricingKind === 'sofa_build') {
    const fabricOk = val.fabrics.some((f) => f.active);
    if (!fabricOk) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fabrics'],
        message: 'Activate at least one fabric — sofas require a fabric choice.',
      });
    }
  }
});

export type ProductInput        = z.infer<typeof productSchema>;
export type SofaProductInput    = z.infer<typeof sofaProductSchema>;
export type SizeProductInput    = z.infer<typeof sizeProductSchema>;
export type BedframeProductInput = z.infer<typeof bedframeProductSchema>;
export type FlatProductInput    = z.infer<typeof flatProductSchema>;
export type TbcProductInput     = z.infer<typeof tbcProductSchema>;
