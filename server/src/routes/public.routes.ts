import { Router } from 'express';
import * as controller from '../controllers/public.controller';
import { validate } from '../middleware/validate.middleware';
import { trackingLimiter } from '../middleware/rateLimit.middleware';
import { trackParamSchema } from '../validators/task.validators';

const router = Router();

// Unauthenticated by design, so it is rate limited by IP.
router.get('/track/:referenceId', trackingLimiter, validate({ params: trackParamSchema }), controller.track);

// Live USDT/INR rate, shown alongside DMC everywhere in the UI. Server-side
// cached (see exchangeRate.service.ts), so this is cheap even under load.
router.get('/rates/usdt-inr', controller.usdtRate);

export default router;
