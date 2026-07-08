// Play is mocked at the service boundary, mirroring how aiChat.test.js mocks geminiService.
// Nothing here touches the real Play Developer API.
jest.mock('../services/playBillingService.js', () => ({
    isBillingEnabled: jest.fn(() => true),
    getSubscription: jest.fn(),
    acknowledgeSubscription: jest.fn().mockResolvedValue(undefined),
}));

// Pub/Sub push authenticates with an OIDC JWT in the Authorization header. Same primitive the
// app already uses for Google Sign-In, so we mock it the same way auth.test.js does.
const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
    // authController constructs an OAuth2Client at module load, which happens while the
    // hoisted `import`s run — before `const mockVerifyIdToken` leaves its temporal dead zone.
    // Deferring the lookup into an arrow keeps the reference lazy until a request is served.
    OAuth2Client: jest.fn().mockImplementation(() => ({
        verifyIdToken: (...args) => mockVerifyIdToken(...args),
    })),
    GoogleAuth: jest.fn(),
}));

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import supertest from 'supertest';
import app from '../app.js';
import User from '../models/User.js';
import {
    isBillingEnabled,
    getSubscription,
    acknowledgeSubscription,
} from '../services/playBillingService.js';

let mongoServer;

const PUBSUB_AUDIENCE = 'https://example.test/api/billing/rtdn';
const PUBSUB_EMAIL = 'pubsub@project.iam.gserviceaccount.com';
const TOKEN = 'play-purchase-token-abc';

const inOneMonth = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const yesterday = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

const activeSubscription = (overrides = {}) => ({
    state: 'SUBSCRIPTION_STATE_ACTIVE',
    isActive: true,
    expiryTime: inOneMonth(),
    productId: 'hybrid_ai_pro_monthly',
    orderId: 'GPA.1234-5678-9012-34567',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    isAcknowledged: false,
    isTestPurchase: true,
    ...overrides,
});

const registerAndToken = async (email = 'buyer@example.com') => {
    const res = await supertest(app)
        .post('/api/auth/register')
        .send({ name: 'Buyer', email, password: 'password123' });
    return res.body.token;
};

const rtdnBody = (subscriptionNotification) => ({
    message: {
        data: Buffer.from(
            JSON.stringify({
                version: '1.0',
                packageName: 'com.hybridai.training',
                eventTimeMillis: `${Date.now()}`,
                subscriptionNotification,
            }),
        ).toString('base64'),
        messageId: 'msg-1',
    },
    subscription: 'projects/p/subscriptions/s',
});

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await User.syncIndexes();

    process.env.PUBSUB_VERIFICATION_AUDIENCE = PUBSUB_AUDIENCE;
    process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL = PUBSUB_EMAIL;
});

beforeEach(() => {
    isBillingEnabled.mockReturnValue(true);
    getSubscription.mockReset();
    acknowledgeSubscription.mockReset().mockResolvedValue(undefined);
    mockVerifyIdToken.mockReset().mockResolvedValue({
        getPayload: () => ({ email: PUBSUB_EMAIL, email_verified: true }),
    });
});

afterEach(async () => {
    await User.deleteMany();
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

describe('POST /api/billing/verify', () => {
    it('grants premium for a valid token and acknowledges it', async () => {
        getSubscription.mockResolvedValue(activeSubscription());
        const token = await registerAndToken();

        const res = await supertest(app)
            .post('/api/billing/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ purchaseToken: TOKEN, productId: 'hybrid_ai_pro_monthly' });

        expect(res.status).toBe(200);
        expect(res.body.data.is_premium).toBe(true);
        expect(res.body.data.status).toBe('premium');

        const user = await User.findOne({ email: 'buyer@example.com' });
        expect(user.isPremium).toBe(true);
        expect(user.subscription.purchaseToken).toBe(TOKEN);
        expect(user.subscription.orderId).toBe('GPA.1234-5678-9012-34567');
        expect(user.subscription.acknowledged).toBe(true);

        expect(acknowledgeSubscription).toHaveBeenCalledWith('hybrid_ai_pro_monthly', TOKEN);
    });

    it('does not grant anything when the subscription is not active', async () => {
        getSubscription.mockResolvedValue(
            activeSubscription({
                state: 'SUBSCRIPTION_STATE_EXPIRED',
                isActive: false,
                expiryTime: yesterday(),
            }),
        );
        const token = await registerAndToken();

        const res = await supertest(app)
            .post('/api/billing/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ purchaseToken: TOKEN });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SUBSCRIPTION_NOT_ACTIVE');
        expect(acknowledgeSubscription).not.toHaveBeenCalled();

        const user = await User.findOne({ email: 'buyer@example.com' });
        expect(user.isPremium).toBe(false);
        expect(user.subscription.purchaseToken).toBeNull();
    });

    it('rejects a token already claimed by another account', async () => {
        getSubscription.mockResolvedValue(activeSubscription());

        const firstToken = await registerAndToken('first@example.com');
        await supertest(app)
            .post('/api/billing/verify')
            .set('Authorization', `Bearer ${firstToken}`)
            .send({ purchaseToken: TOKEN });

        const secondToken = await registerAndToken('second@example.com');
        const res = await supertest(app)
            .post('/api/billing/verify')
            .set('Authorization', `Bearer ${secondToken}`)
            .send({ purchaseToken: TOKEN });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TOKEN_ALREADY_CLAIMED');

        const second = await User.findOne({ email: 'second@example.com' });
        expect(second.isPremium).toBe(false);
    });

    it('is idempotent — re-verifying an owned token does not acknowledge twice', async () => {
        // Google reports the purchase as acknowledged once we have acknowledged it.
        getSubscription
            .mockResolvedValueOnce(activeSubscription({ isAcknowledged: false }))
            .mockResolvedValue(
                activeSubscription({
                    isAcknowledged: true,
                    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
                }),
            );

        const token = await registerAndToken();
        const send = () =>
            supertest(app)
                .post('/api/billing/verify')
                .set('Authorization', `Bearer ${token}`)
                .send({ purchaseToken: TOKEN });

        expect((await send()).status).toBe(200);
        expect((await send()).status).toBe(200); // this is what "Restore Purchases" does

        expect(acknowledgeSubscription).toHaveBeenCalledTimes(1);

        const user = await User.findOne({ email: 'buyer@example.com' });
        expect(user.isPremium).toBe(true);
    });

    it('returns 503 rather than granting when billing is disabled', async () => {
        isBillingEnabled.mockReturnValue(false);
        const token = await registerAndToken();

        const res = await supertest(app)
            .post('/api/billing/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ purchaseToken: TOKEN });

        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(getSubscription).not.toHaveBeenCalled();

        const user = await User.findOne({ email: 'buyer@example.com' });
        expect(user.isPremium).toBe(false);
    });

    it('never grants premium when Play cannot be reached', async () => {
        getSubscription.mockRejectedValue(new Error('network down'));
        const token = await registerAndToken();

        const res = await supertest(app)
            .post('/api/billing/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ purchaseToken: TOKEN });

        expect(res.status).toBe(502);

        const user = await User.findOne({ email: 'buyer@example.com' });
        expect(user.isPremium).toBe(false);
    });
});

describe('POST /api/billing/rtdn', () => {
    const grantPremium = async () => {
        getSubscription.mockResolvedValue(activeSubscription());
        const token = await registerAndToken();
        await supertest(app)
            .post('/api/billing/verify')
            .set('Authorization', `Bearer ${token}`)
            .send({ purchaseToken: TOKEN });
        getSubscription.mockReset();
    };

    it('revokes premium when Play reports the subscription expired', async () => {
        await grantPremium();

        // The handler ignores notificationType and re-queries Play, which is the source of truth.
        getSubscription.mockResolvedValue(
            activeSubscription({
                state: 'SUBSCRIPTION_STATE_EXPIRED',
                isActive: false,
                expiryTime: yesterday(),
            }),
        );

        const res = await supertest(app)
            .post('/api/billing/rtdn')
            .set('Authorization', 'Bearer valid-oidc-token')
            .send(rtdnBody({ notificationType: 13, purchaseToken: TOKEN, subscriptionId: 'hybrid_ai_pro_monthly' }));

        expect(res.status).toBe(204);

        const user = await User.findOne({ email: 'buyer@example.com' });
        expect(user.isPremium).toBe(false);
        expect(user.subscription.state).toBe('SUBSCRIPTION_STATE_EXPIRED');
    });

    it('is idempotent — replaying the same notification changes nothing', async () => {
        await grantPremium();
        getSubscription.mockResolvedValue(activeSubscription({ isAcknowledged: true }));

        const send = () =>
            supertest(app)
                .post('/api/billing/rtdn')
                .set('Authorization', 'Bearer valid-oidc-token')
                .send(rtdnBody({ notificationType: 2, purchaseToken: TOKEN, subscriptionId: 'hybrid_ai_pro_monthly' }));

        await send();
        await send();

        const user = await User.findOne({ email: 'buyer@example.com' });
        expect(user.isPremium).toBe(true);
    });

    it('rejects a request without a valid Pub/Sub OIDC token', async () => {
        await grantPremium();
        mockVerifyIdToken.mockRejectedValue(new Error('bad signature'));

        const res = await supertest(app)
            .post('/api/billing/rtdn')
            .set('Authorization', 'Bearer forged')
            .send(rtdnBody({ notificationType: 13, purchaseToken: TOKEN }));

        expect(res.status).toBe(401);
        expect(getSubscription).not.toHaveBeenCalled();

        const user = await User.findOne({ email: 'buyer@example.com' });
        expect(user.isPremium).toBe(true); // untouched
    });

    it('rejects an OIDC token minted for a different service account', async () => {
        mockVerifyIdToken.mockResolvedValue({
            getPayload: () => ({ email: 'attacker@evil.example', email_verified: true }),
        });

        const res = await supertest(app)
            .post('/api/billing/rtdn')
            .set('Authorization', 'Bearer other-google-client')
            .send(rtdnBody({ notificationType: 13, purchaseToken: TOKEN }));

        expect(res.status).toBe(401);
    });

    it('swallows a notification for an unknown token without retrying', async () => {
        const res = await supertest(app)
            .post('/api/billing/rtdn')
            .set('Authorization', 'Bearer valid-oidc-token')
            .send(rtdnBody({ notificationType: 4, purchaseToken: 'never-seen' }));

        // 2xx: a redelivery cannot fix an unknown token, and a non-2xx makes Pub/Sub loop.
        expect(res.status).toBe(204);
    });
});
