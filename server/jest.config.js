/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/tests/**/*.test.ts'],
  clearMocks: true,
  collectCoverageFrom: ['src/**/*.ts', '!src/tests/**', '!src/seed/**'],
  testTimeout: 30000,
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { noUnusedLocals: false, noUnusedParameters: false } }] },
};
