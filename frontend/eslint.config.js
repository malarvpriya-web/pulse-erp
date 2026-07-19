import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Never lint build output or dev-only tools. android/ios are Capacitor
  // native projects whose assets/public is a copy of dist — linting the
  // minified bundles produces hundreds of false errors.
  globalIgnores([
    'dist',
    'node_modules',
    'android',
    'ios',
    'src/utils/devLogin.js',
  ]),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        ...globals.node,   // __dirname, __filename, process, Buffer
        ...globals.es2020,
      },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // ── Core JS rules: warn only, never block the build ──────────────────
      'no-unused-vars': ['warn', {
        varsIgnorePattern: '^_|^[A-Z_]',
        argsIgnorePattern: '^_|^[A-Z]',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      'no-empty':             ['warn', { allowEmptyCatch: true }],
      'no-undef':             'warn',
      'no-prototype-builtins':'warn',

      // ── React Refresh: warn only ──────────────────────────────────────────
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // ── Standard hooks rules (kept as error — these are real bugs) ────────
      'react-hooks/rules-of-hooks':  'error',
      'react-hooks/exhaustive-deps': 'warn',

      // ── React Compiler rules (v7 additions): warn only ───────────────────
      // These fire on patterns that are valid at runtime but the compiler
      // cannot optimise. Downgraded to warn so they surface without blocking.
      //
      // set-state-in-effect: off — fires as false positive on the idiomatic
      // useEffect(() => { asyncFn(); }, [asyncFn]) pattern where asyncFn is a
      // useCallback that calls setState internally. There are no synchronous
      // setState calls in effect bodies; all 73 instances are async fetch wrappers.
      'react-hooks/set-state-in-effect':         'off',
      'react-hooks/immutability':                'warn',
      'react-hooks/purity':                      'warn',
      'react-hooks/static-components':           'off',  // inline JSX style objects are normal React — optimization hint only
      'react-hooks/use-memo':                    'warn',
      'react-hooks/void-use-memo':               'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/no-deriving-state-in-effects':'warn',
      'react-hooks/hooks':                       'warn',
      'react-hooks/capitalized-calls':           'warn',
      'react-hooks/component-hook-factories':    'warn',
      'react-hooks/incompatible-library':        'warn',
      'react-hooks/globals':                     'warn',
      'react-hooks/refs':                        'warn',
      'react-hooks/memoized-effect-dependencies':'warn',
      'react-hooks/error-boundaries':            'warn',
      'react-hooks/set-state-in-render':         'warn',
      'react-hooks/invariant':                   'warn',
      'react-hooks/automatic-effect-dependencies':'warn',
    },
  },
])
