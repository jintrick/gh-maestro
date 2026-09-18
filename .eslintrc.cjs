module.exports = {
  env: {
    es2021: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2021,
  },
  ignorePatterns: [
    'node_modules/',
  ],
  overrides: [
    {
      files: ['scripts/**/*.js', 'tests/**/*.js'],
      rules: {
        'no-undef': 'error',
      },
    },
  ],
};
