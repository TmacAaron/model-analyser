import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const runId=process.env['MODEL_ANALYSER_E2E_RUN_ID']??=randomUUID();
if(!/^[a-f0-9-]{36}$/i.test(runId))throw Error('Invalid isolated E2E run ID');
export default defineConfig({testDir:'tests/e2e',workers:1,expect:{timeout:15000},use:{baseURL:'http://127.0.0.1:4311',channel:'chrome',headless:true},
  webServer:{command:`"${process.execPath}" node_modules/tsx/dist/cli.mjs apps/local/src/server.ts`,url:'http://127.0.0.1:4311',reuseExistingServer:false,env:{PORT:'4311',MODEL_ANALYSER_DATA:'data/e2e/runs/'+runId}}});
