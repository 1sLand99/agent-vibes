// @ts-check
import eslint from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: ["eslint.config.mjs", "dist/**", "src/gen/**", "sea/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts", "**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: "commonjs",
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: [
      "src/protocol/cursor/cursor-connect-stream.service.ts",
      "src/protocol/cursor/cursor-grpc.service.ts",
      "src/protocol/cursor/tools/cursor-request-parser.ts",
    ],
    rules: {
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // Turn-runner interfaces declare async methods that satisfy a contract
    // and may not themselves use `await`.
    files: [
      "src/protocol/cursor/turn/**/*.ts",
      "src/protocol/cursor/bidi/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/require-await": "off",
      "require-yield": "off",
    },
  },
  {
    files: ["src/protocol/cursor/cursor-connect-stream.service.ts"],
    rules: {
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-base-to-string": "off",
    },
  },
  {
    files: ["src/protocol/cursor/cursor-grpc.service.ts"],
    rules: {
      "@typescript-eslint/no-base-to-string": "off",
    },
  },
  {
    files: ["sea/sea-entry.ts", "src/main.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // Jest spec files commonly assert on mock methods read off class
    // instances (`expect(service.method).toHaveBeenCalled()`); the
    // strict `unbound-method` rule is a constant false positive in
    // that idiom — the test does not actually invoke the unbound
    // reference. Tests are also free to script async generators that
    // do not yield in every branch and to fabricate handles whose
    // `this` is never read.
    files: ["**/*.spec.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/unbound-method": "off",
    },
  }
)
