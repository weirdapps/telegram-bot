import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test_scripts/**/test-*.ts'],
    passWithNoTests: true,
    // SonarCloud reads coverage/lcov.info (sonar-project.properties); the default
    // reporters write no lcov, so every PR showed 0% coverage on new code.
    coverage: {
      reporter: ['text-summary', 'lcov'],
    },
  },
});
