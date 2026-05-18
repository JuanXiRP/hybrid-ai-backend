import express from 'express';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cors from 'cors';
import connectDB from './config/db.js';
import userRoutes from './routes/userRoutes.js';
import workoutRoutes from './routes/workoutRoutes.js';
import aiRoutes from './routes/aiRoutes.js';
import authRoutes from './routes/authRoutes.js';
import workoutPlanRoutes from './routes/workoutPlanRoutes.js';

// Load environment variables
dotenv.config();
// Connect to MongoDB
connectDB();

const app = express();
const PORT = process.env.PORT || 3000;

// Apply security headers
app.use(helmet());

// Enable CORS for frontend communication
app.use(cors());

// Parse incoming JSON requests
app.use(express.json());

// Health check endpoint for DevOps monitoring
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        environment: process.env.NODE_ENV,
        timestamp: new Date().toISOString()
    });
});

// Routes
app.use('/api/users', userRoutes);
app.use('/api/workouts', workoutRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/plans', workoutPlanRoutes);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});