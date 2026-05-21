import jwt from 'jsonwebtoken';

const generateToken = (id) => {
    // Falls back to '30d' (30 days) if the environment variable is missing
    const expiration = process.env.JWT_EXPIRES_IN || '30d'; 

    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: expiration, 
    });
};

export default generateToken;