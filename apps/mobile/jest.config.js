module.exports = {
  preset: '@react-native/jest-preset',
  setupFilesAfterEnv: ['./jest.setup.js'],
  moduleNameMapper: {
    '^@cove/contracts$': '<rootDir>/../../packages/contracts/dist',
    '^@cove/client-core$': '<rootDir>/../../packages/client-core/dist',
  },
};
