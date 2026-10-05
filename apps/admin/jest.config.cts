// Pin the suite's time zone to a zone west of UTC -- the organization's own,
// America/Mexico_City (UTC-6). A calendar date the API sends as midnight UTC
// slips to the previous day there if a template formats it in the device's
// zone, and the specs must catch that whether they run on a developer's
// machine or on a UTC CI runner. Set here, before Jest starts its workers,
// because Jest sandboxes `process.env` per test file and an assignment inside
// a spec never reaches the runtime.
process.env.TZ = 'America/Mexico_City';

module.exports = {
  displayName: 'admin',
  preset: '../../jest.preset.js',
  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  coverageDirectory: '../../coverage/apps/admin',
  transform: {
    '^.+\\.(ts|mjs|js|html)$': [
      'jest-preset-angular',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
        stringifyContentPathRegex: '\\.(html|svg)$',
      },
    ],
  },
  transformIgnorePatterns: ['node_modules/(?!.*\\.mjs$)'],
  snapshotSerializers: [
    'jest-preset-angular/build/serializers/no-ng-attributes',
    'jest-preset-angular/build/serializers/ng-snapshot',
    'jest-preset-angular/build/serializers/html-comment',
  ],
};
