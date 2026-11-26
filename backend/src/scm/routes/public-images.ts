
import { Hono } from 'hono';
import { modelPhotoProxyHandler } from './product-models';
import { categoryHeroBlobHandler } from './categories';
import { compartmentPhotoProxyHandler } from './sofa-compartment-photos';
import type { Env, Variables } from '../env';

export const publicScmImages = new Hono<{ Bindings: Env; Variables: Variables }>();

publicScmImages.get('/product-models/:id/photo/:key', modelPhotoProxyHandler);
publicScmImages.get('/categories/:id/hero-blob', categoryHeroBlobHandler);
publicScmImages.get('/maintenance-config/sofa-compartments/:code/photo/:key', compartmentPhotoProxyHandler);
