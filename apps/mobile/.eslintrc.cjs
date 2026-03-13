module.exports = {
  extends: ['../../packages/config/eslint/base.cjs'],
  parserOptions: {
    ecmaFeatures: {
      jsx: true
    }
  },
  settings: {
    'import/parsers': {
      '@typescript-eslint/parser': ['.ts', '.tsx']
    },
    'import/ignore': ['node_modules/react-native/.*']
  }
};
