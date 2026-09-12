import { Router } from 'express';
import * as controller from '../controllers/auth.controller';
import * as registration from '../controllers/captainRegistration.controller';
import { validate } from '../middleware/validate.middleware';
import { requireAuth } from '../middleware/auth.middleware';
import { loginLimiter, otpLimiter } from '../middleware/rateLimit.middleware';
import { loginSchema, verifyOtpSchema, resendOtpSchema } from '../validators/auth.validators';
import {
  registerCaptainSchema,
  verifyRegistrationSchema,
  resendRegistrationSchema,
  registrationIdParamSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '../validators/captainRegistration.validators';

const router = Router();

router.post('/login', loginLimiter, validate({ body: loginSchema }), controller.login);
router.post('/verify-otp', otpLimiter, validate({ body: verifyOtpSchema }), controller.verifyOtp);
router.post('/resend-otp', otpLimiter, validate({ body: resendOtpSchema }), controller.resend);

/**
 * PUBLIC CAPTAIN REGISTRATION
 *
 * Open, so rate limited on the way in. `loginLimiter` guards the step that
 * creates something and `otpLimiter` the code steps, which is the same pairing
 * signing in uses — a registration attempt costs an administrator's attention
 * in exactly the way a sign-in attempt costs a session, so they are metered
 * alike.
 *
 * None of these issue a cookie. Registering is not a way to become signed in.
 */
router.post(
  '/captain/register',
  loginLimiter,
  validate({ body: registerCaptainSchema }),
  registration.register,
);
router.post(
  '/captain/register/verify',
  otpLimiter,
  validate({ body: verifyRegistrationSchema }),
  registration.verify,
);
router.post(
  '/captain/register/resend',
  otpLimiter,
  validate({ body: resendRegistrationSchema }),
  registration.resend,
);
router.get(
  '/captain/register/:registrationId',
  validate({ params: registrationIdParamSchema }),
  registration.status,
);

/**
 * FORGOTTEN PASSWORD
 *
 * Step one answers identically whether or not the address is known, so it
 * cannot be used to find out which addresses have accounts.
 */
router.post(
  '/forgot-password',
  loginLimiter,
  validate({ body: forgotPasswordSchema }),
  controller.forgotPassword,
);
router.post(
  '/reset-password',
  otpLimiter,
  validate({ body: resetPasswordSchema }),
  controller.resetPassword,
);
router.post('/refresh', controller.refresh);
router.post('/logout', requireAuth, controller.logout);
router.get('/me', requireAuth, controller.me);

export default router;
