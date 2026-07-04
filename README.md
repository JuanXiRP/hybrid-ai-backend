# Hybrid AI Training - Backend API

RESTful backend designed for the Hybrid AI Training mobile app. It acts as the central core of the business logic: it manages authentication, persists biometric data, and orchestrates communication with Google Gemini 2.5 Flash to generate hyper-personalized training plans.

## Architecture and Design Patterns

The system is built following SOLID principles and Clean Architecture, ensuring scalability, low coupling, and high resilience.

* Deterministic AI Integration: Uses Gemini 2.5's native `responseMimeType: "application/json"` mode to guarantee structured, strict output, eliminating regular-expression-based parsing.
* Exponential Backoff: The server intercepts Google Cloud 503 and 429 errors and performs dynamically spaced retries (2s → 4s → 8s) to prevent the error from propagating to the mobile client.
* Stateless Security: Authentication via stateless in-memory JWT, enabling transparent horizontal scaling. Password hashing with `bcryptjs` through Mongoose pre-save hooks.
* Denormalized Modeling (NoSQL): Generated routines are stored as nested JSON documents in MongoDB, optimizing reads to a single O(1) query from the client.

## Tech Stack

* Runtime: Node.js (ESModules)
* Framework: Express.js
* Database: MongoDB Atlas + Mongoose ODM
* Security: jsonwebtoken, bcryptjs
* AI: @google/generative-ai

## Local Installation and Setup

### Prerequisites

* Node.js v18+
* An active API key from Google AI Studio
* A MongoDB Atlas cluster or a local instance
