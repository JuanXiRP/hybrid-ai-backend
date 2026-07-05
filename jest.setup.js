// Raise the default timeout so the in-memory MongoDB startup in beforeAll hooks does not
// flake under parallel test workers (each suite spins up its own mongod instance).
jest.setTimeout(30000);
