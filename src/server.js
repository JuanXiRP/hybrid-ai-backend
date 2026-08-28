import app from './app.js';
import connectDB from './config/db.js';
import { assertRequiredEnv } from './config/env.js';

const PORT = process.env.PORT || 10000;

const start = async () => {
    try {
        assertRequiredEnv();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }

    // Connect BEFORE listening. The previous version fired connectDB() without awaiting and called
    // app.listen in parallel, so the log printed "Server running on port 10000" moments before the
    // process died on a failed connection — the single most misleading line in the deploy log.
    await connectDB();

    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
};

start();
