// The single place any API path is written down. Changing a route means changing one line here,
// not hunting through every suite that happens to call it.

export const ROUTES = {
  // auth
  register: "/api/auth/register",
  login: "/api/auth/login",
  googleLogin: "/api/auth/google",

  // users
  createUser: "/api/users",
  profile: "/api/users/profile",

  // ai
  chat: "/api/ai/chat",
  generatePlan: "/api/ai/generate-plan",
  importPlan: "/api/ai/import-plan",

  // workouts
  strengthWorkout: "/api/workouts/strength",
  runWorkout: "/api/workouts/run",

  // plans
  activePlan: "/api/plans/active",
  planHistory: "/api/plans/history",

  // billing
  verifyPurchase: "/api/billing/verify",
  entitlement: "/api/billing/entitlement",
  rtdn: "/api/billing/rtdn",

  health: "/health",
};
