import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // The libav.js build and its upstream typings are vendored verbatim so the
  // exact artifact that was measured is the one that ships. Linting someone
  // else's generated code says nothing about this codebase.
  // The EIA-608 parser is hls.js's, copied because they publish it only as
  // TypeScript under node_modules. Its header says the logic is unmodified and
  // to re-copy rather than edit, so lint findings there are upstream's to make
  // - and "fixing" them here would be a diff against the next copy.
  globalIgnores(['dist', 'src/lib/wasmlive/vendor', 'src/lib/captions/cea608.ts']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // A leading underscore is how this codebase already says "required by
      // the signature, deliberately unused" - `_message`, `_oid`, `_t`. The
      // rule's default flags exactly the convention the code is written in.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
])
