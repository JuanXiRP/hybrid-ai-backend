import mongoose from 'mongoose';
import supertest from 'supertest';
import app from '../app.js';
import { assertRequiredEnv } from '../config/env.js';

const validEnv = {
    MONGO_URI: 'mongodb://localhost:27017/test',
    JWT_SECRET: 'secret',
    GEMINI_API_KEY: 'key',
    GOOGLE_WEB_CLIENT_ID: 'client-id',
};

describe('assertRequiredEnv', () => {
    it('passes when every required variable is present', () => {
        expect(() => assertRequiredEnv(validEnv)).not.toThrow();
    });

    it('names every missing variable in one go', () => {
        expect(() => assertRequiredEnv({ JWT_SECRET: 'secret' })).toThrow(
            /MONGO_URI, GEMINI_API_KEY/,
        );
    });

    it('treats a blank value as missing', () => {
        expect(() => assertRequiredEnv({ ...validEnv, MONGO_URI: '   ' })).toThrow(/MONGO_URI/);
    });

    it('warns but does not throw when GOOGLE_WEB_CLIENT_ID is absent', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { GOOGLE_WEB_CLIENT_ID, ...withoutClientId } = validEnv;

        expect(() => assertRequiredEnv(withoutClientId)).not.toThrow();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('GOOGLE_WEB_CLIENT_ID'));

        warn.mockRestore();
    });
});

// The connection is stubbed rather than backed by a real mongod: every other suite already boots
// its own MongoMemoryServer, and adding a seventh made them contend and time out on startup.
// Stubbing also buys the one case a live server cannot produce on demand — a hanging ping.
describe('GET /health', () => {
    const stubConnection = ({ readyState, ping }) => {
        Object.defineProperty(mongoose.connection, 'readyState', {
            value: readyState,
            configurable: true,
        });
        Object.defineProperty(mongoose.connection, 'db', {
            value: { admin: () => ({ ping }) },
            configurable: true,
        });
    };

    afterEach(() => {
        delete mongoose.connection.readyState;
        delete mongoose.connection.db;
    });

    it('reports DEGRADED when the driver is not connected', async () => {
        const ping = jest.fn();
        stubConnection({ readyState: 0, ping });

        const res = await supertest(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('DEGRADED');
        expect(res.body.database).toBe('down');
        // Short-circuits: no point pinging a socket we know is closed.
        expect(ping).not.toHaveBeenCalled();
    });

    it('reports UP when Mongo answers the ping', async () => {
        stubConnection({ readyState: 1, ping: jest.fn().mockResolvedValue({ ok: 1 }) });

        const res = await supertest(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('UP');
        expect(res.body.database).toBe('connected');
    });

    it('reports DEGRADED when the ping fails, even though readyState claims connected', async () => {
        stubConnection({
            readyState: 1,
            ping: jest.fn().mockRejectedValue(new Error('connection reset')),
        });

        const res = await supertest(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body.database).toBe('down');
    });

    it('does not hang forever when the ping never settles', async () => {
        stubConnection({ readyState: 1, ping: jest.fn(() => new Promise(() => {})) });

        const res = await supertest(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body.database).toBe('down');
    }, 10000);
});
