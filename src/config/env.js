// src/config/env.js
//
// Fail-fast check that the process has what it needs before it accepts traffic.
//
// Without this, a missing MONGO_URI surfaces as mongoose's opaque
// "uri parameter to openUri() must be a string, got undefined" — exactly the kind of error that
// costs an afternoon on a hosted deploy where you cannot attach a debugger.
//
// Note on ordering: ESM imports hoist, so modules that read env at load time (geminiService builds
// its Gemini client that way) run before this validator does. That is fine — none of them throw on
// an undefined value, they just fail later at call time. This still reports before we listen.

const REQUIRED_VARS = ['MONGO_URI', 'JWT_SECRET', 'GEMINI_API_KEY'];

// Not fatal, but worth shouting about: with no audience configured, verifyIdToken accepts a token
// minted for ANY other Google client. Warn rather than exit so local development keeps working.
const SECURITY_SENSITIVE_VARS = ['GOOGLE_WEB_CLIENT_ID'];

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

/**
 * @throws {Error} naming every missing variable, so one restart tells you all of them.
 */
export const assertRequiredEnv = (env = process.env) => {
    const missing = REQUIRED_VARS.filter((name) => isBlank(env[name]));

    if (missing.length > 0) {
        throw new Error(
            `[Config] Missing required environment variable(s): ${missing.join(', ')}. ` +
            'Set them in .env locally, or in the Environment tab of your host.'
        );
    }

    for (const name of SECURITY_SENSITIVE_VARS) {
        if (isBlank(env[name])) {
            console.warn(
                `[Config] ${name} is not set. Google ID tokens will be verified without an ` +
                'audience check, which accepts tokens minted for any other Google client.'
            );
        }
    }
};

export default assertRequiredEnv;
