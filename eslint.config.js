// ESLint 9 flat config. The eslintrc format is no longer read, so this file is the single
// source of lint truth for both `src/` (ESM) and `tests/` (ESM, plus two .cjs entrypoints
// that Jest loads outside the Babel transform).

import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["coverage/**", "node_modules/**", "trivy-report.json"],
  },

  js.configs.recommended,

  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      // `args: 'after-used'` plus `ignoreRestSiblings` is what lets the codebase's
      // omit-by-destructuring idiom stand without renaming the discarded bindings
      // (see aiController's payload sanitising and startup.test's env stripping).
      "no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
          // ESLint 9 flipped this default to 'all'; an unused `catch (error)` is
          // idiomatic here and not worth flagging.
          caughtErrors: "none",
        },
      ],
    },
  },

  {
    // Test files and shared test infrastructure get the Jest globals.
    files: ["src/**/*.test.js", "tests/**/*.js", "tests/**/*.cjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
  },

  {
    // globalSetup/globalTeardown are required by Jest as plain CommonJS.
    files: ["tests/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
    },
  },
];
