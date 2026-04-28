/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@zeromem/sdk$': '<rootDir>/../sdk/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'CommonJS',
          moduleResolution: 'node',
          types: ['jest', 'node'],
          baseUrl: '.',
          paths: {
            '@zeromem/sdk': ['../sdk/src/index.ts'],
          },
        },
      },
    ],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/__tests__/**'],
};
