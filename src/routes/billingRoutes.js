// src/routes/billingRoutes.js
import express from 'express';
import {
    verifyPurchase,
    getEntitlementStatus,
    handleRtdn,
} from '../controllers/billingController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// Doubles as "Restore Purchases": re-verifying an owned token is idempotent, so the client
// simply replays each token from queryPurchasesAsync through here.
router.post('/verify', protect, verifyPurchase);

router.get('/entitlement', protect, getEntitlementStatus);

// Public. Authenticated inside the handler via the Pub/Sub OIDC token in the Authorization
// header — it must NOT sit behind `protect`, which expects a user JWT.
router.post('/rtdn', handleRtdn);

export default router;
