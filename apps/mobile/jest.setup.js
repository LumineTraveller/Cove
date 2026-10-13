/* eslint-env jest */
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    multiGet: jest.fn(async keys => keys.map(key => [key, null])),
    multiSet: jest.fn(async () => undefined),
    multiRemove: jest.fn(async () => undefined),
    getAllKeys: jest.fn(async () => []),
    clear: jest.fn(async () => undefined),
  },
}));
