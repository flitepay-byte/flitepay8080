// @ts-check
/**
 * Lint configuration for the server.
 *
 * The scope is deliberately narrow, and it is worth saying why rather than
 * reaching for a preset.
 *
 * `tsc` already runs in strict mode with `noUnusedLocals` and
 * `noUnusedParameters`, so it catches most of what a general-purpose linter
 * would, and it catches it earlier. Turning on `recommendedTypeChecked`
 * wholesale produced 226 complaints against working code — almost all of them
 * `no-unsafe-*` and `restrict-template-expressions` objecting to how an
 * established codebase types its boundaries, not defects. Silencing 200
 * findings to reach a green run teaches nobody anything, and quietly rewriting
 * 200 lines of working money code to satisfy a linter is worse.
 *
 * So the rules here are the ones that find a *bug* rather than a style, chosen
 * one at a time:
 *
 *   - `no-floating-promises` is the reason this config exists. An unawaited
 *     promise in a money path means the caller returns, the response goes out,
 *     and the write lands later or not at all. Nothing else in the toolchain
 *     sees it. It currently reports zero, and the value is in keeping it there.
 *   - `await-thenable` catches an `await` on something that was never a
 *     promise, which is usually a call that lost its parentheses.
 *   - `no-misused-promises` is kept for conditionals and spreads, where a
 *     promise in a boolean position is always truthy. Its `checksVoidReturn`
 *     arm is off: this codebase's async middleware wrap their whole body in
 *     try/catch and call `next(err)`, so their promise cannot reject, and the
 *     rule cannot tell that apart from one that can. Six such sites are safe by
 *     construction and are covered by the route contract tests.
 *
 * The type-aware rules need real type information, hence `projectService`.
 * Generated output and dependencies are excluded; tests are linted too, since a
 * forgotten `await` in a test makes it pass for no reason.
 */
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.mjs', 'jest.config.js'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],

      /**
       * `noUnusedLocals` already covers unused variables, so this is here only
       * for the underscore convention the codebase uses to mark a parameter it
       * must accept and deliberately does not read.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      /**
       * Mocks are legitimately `async` with nothing to await — they stand in
       * for an async API and must match its shape. `require-await` cannot tell
       * those from a function that forgot its await, and the latter is already
       * caught by `no-floating-promises` at the call site.
       */
      '@typescript-eslint/require-await': 'off',

      /**
       * Application code speaks through `logger`, which carries a request id
       * and a level; a bare `console.log` reaching production is a line nobody
       * can find again. The three deliberate exceptions already carry their own
       * disable comment, which is why this rule is on rather than absent.
       */
      'no-console': 'error',
    },
  },
  {
    /**
     * The audit and diagnostic runners under `src/audit` are command-line
     * tools. Printing a reconciliation table to a terminal is the whole point
     * of them, and the `_check-*` walkthroughs read untyped JSON back off a
     * running demo server, where `any` is an honest description of what
     * arrives rather than a gap in the typing.
     */
    files: ['src/audit/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
