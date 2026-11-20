import {defineConfig} from 'vitest/config';
// Bound simultaneous file-library scans as the source-backed preset catalog grows.
export default defineConfig({test:{include:['tests/**/*.test.ts'],maxWorkers:4}});
