module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['babel-jest', {
      babelrc: false,
      configFile: false,
      plugins: [
        ['@babel/plugin-transform-typescript', {isTSX: false}],
        ['@babel/plugin-transform-modules-commonjs', {loose: true}],
      ],
    }],
  },
  coverageDirectory: 'coverage',
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/dist/'],
  coveragePathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/dist/' ],
};
