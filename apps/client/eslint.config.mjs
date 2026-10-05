import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import baseConfig from '../../eslint.config.mjs';

export default tseslint.config(
  ...baseConfig,
  {
    // The native platforms (`npx cap add ios|android`) are generated,
    // vendored project trees, not source this app owns: `ios/` carries
    // Capacitor's own bundled `native-bridge.js` (inside the Swift Package
    // checkout and, if present locally, Xcode's `build/` DerivedData) and
    // `android/` carries its Gradle wrapper. Both also hold a synced copy of
    // this app's own `dist` output (`ios/App/App/public`,
    // `android/app/src/main/assets/public`) from the last `cap sync` --
    // linting that is linting a build artifact a second time under a
    // different path.
    ignores: ['ios/**', 'android/**'],
  },
  {
    files: ['**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'rm', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'rm', style: 'kebab-case' },
      ],
    },
  },
  {
    files: ['**/*.html'],
    extends: [
      ...angular.configs.templateRecommended,
      ...angular.configs.templateAccessibility,
    ],
    rules: {},
  },
);
