// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    rules: {
      // This app's UI copy is deliberately conversational prose (an
      // "advisor voice," not terse labels) and uses plain apostrophes/
      // quotes throughout - this rule would otherwise demand escaping
      // ~50 existing, correct call sites for a purely stylistic JSX
      // convention with no real bug behind it. React renders a literal
      // '/" in JSX text fine; this isn't a functional issue.
      "react/no-unescaped-entities": "off",
    },
  },
]);
