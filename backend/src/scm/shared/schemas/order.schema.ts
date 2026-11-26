
import { z } from 'zod';

import { PAYMENT_METHOD_CODES } from '../payment-methods';

const cellSchema = z.object({
  moduleId: z.string(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  rot: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  recliners: z.array(z.object({ seatIdx: z.number().int(), open: z.boolean() })).optional(),
});

const sofaConfigSchema = z.object({
  depth: z.string().regex(/^\d{2,3}$/),
  mode: z.enum(['preset', 'custom']),
  presetId: z.string().optional(),
  quickFlip: z.enum(['L', 'R']).optional(),
  customCells: z.array(cellSchema),
  fabricId: z.string().optional(),
  colourId: z.string().optional(),
  fabricLabel: z.string().optional(),
  colourLabel: z.string().optional(),
});

const mattressConfigSchema = z.object({
  sizeId: z.string(),
  freePillows: z.number().int().min(0).optional(),
  extraPillows: z.number().int().min(0).optional(),
});

const bedframeConfigSchema = z.object({
  sizeId: z.string(),
  colourId: z.string().optional(),
  gapId: z.string().optional(),
  gapOther: z.string().optional(),
});

export const itemConfigSchema = z.union([
  sofaConfigSchema,
  mattressConfigSchema,
  bedframeConfigSchema,
]);

export const cartItemSchema = z.object({
  productId: z.string().uuid(),
  qty: z.number().int().positive(),
  config: itemConfigSchema.optional(),
});

export const cartAddonSchema = z.object({
  id: z.string(),
  qty: z.number().int().positive().optional(),
  floors: z.number().int().min(0).optional(),
  items: z.number().int().min(0).optional(),
});

export const customerDtoSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  address: z.string().optional(),
  addressLine2: z.string().optional(),
  postcode: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
});

export const orderPostSchema = z.object({
  customer: customerDtoSchema,
  emergency: z
    .object({ name: z.string(), phone: z.string(), relation: z.string() })
    .nullable(),
  cart: z.array(cartItemSchema).min(1),
  addons: z.array(cartAddonSchema),
  delivery: z.object({
    date: z.string().nullable(),
    slot: z.string().nullable(),
    tbd: z.boolean(),
    notes: z.string().optional(),
  }),
  paymentMethod: z.enum(PAYMENT_METHOD_CODES),
  approvalCode: z.string().optional(),
  slipKey: z.string().optional(),
  uploadSessionId: z.string().optional(),

  clientSubtotal: z.number().int(),
  clientAddonTotal: z.number().int(),
  clientTotal: z.number().int(),
  clientPaid: z.number().int(),
});

export type OrderPostBody = z.infer<typeof orderPostSchema>;
export type CartItem = z.infer<typeof cartItemSchema>;
export type SofaConfig = z.infer<typeof sofaConfigSchema>;
