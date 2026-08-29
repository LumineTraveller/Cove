module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    {
      files: ['__tests__/**/*.js', '__tests__/**/*.cjs'],
      env: {
        node: true,
        jest: true,
      },
    },
  ],
};
