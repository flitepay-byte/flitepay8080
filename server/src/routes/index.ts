import { Router } from 'express';
import authRoutes from './auth.routes';
import partyRoutes from './party.routes';
import captainRoutes from './captain.routes';
import adminRoutes from './admin.routes';
import publicRoutes from './public.routes';
import apiRoutes from './api.routes';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) } });
});

router.use('/auth', authRoutes);
router.use('/party', partyRoutes);
router.use('/captain', captainRoutes);
router.use('/admin', adminRoutes);
router.use('/public', publicRoutes);
// The party-facing API. Kept on its own mount so its signed authentication
// never shares middleware with the browser dashboard's cookie session.
router.use('/api', apiRoutes);

export default router;
