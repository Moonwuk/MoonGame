// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // The prototype is throwaway demo code (browser globals, deep relative
    // imports into shared-core); it is built with esbuild, not part of the core.
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'prototype/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Determinism guardrails — enforced only inside the simulation core.
    // See docs/architecture.md §4.2.
    files: ['packages/shared-core/src/**/*.ts'],
    ignores: ['packages/shared-core/src/**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Determinism: use the seeded Rng, never Math.random().',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Determinism: pass time as a parameter (Context.now), never Date.now().',
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message: 'Determinism: time must be a parameter in shared-core; avoid Date here.',
        },
      ],
    },
  },
);
